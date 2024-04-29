import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

import { ProgressLocation, window } from 'vscode';
import { JSONRPCClient, JSONRPCRequest, JSONRPCResponse, TypedJSONRPCClient } from 'json-rpc-2.0';
import { WebSocket, Data } from 'ws';
import * as vscode from 'vscode';
import { Subject, filter, map } from 'rxjs';

import { MutantResult } from '../api/mutant-result.js';
import { Logger } from '../utils/logger.js';
import { config } from '../config.js';

import { InstrumentParams, MutateParams, MutatePartialResult, MutationServerMethods, ProgressParams } from './mutation-server-methods.js';

export class MutationServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private rpcClient: TypedJSONRPCClient<MutationServerMethods> | undefined;
  private webSocket: WebSocket | undefined;

  private readonly notification$Subject = new Subject<JSONRPCRequest>();
  public progressNotification$ = this.notification$Subject.pipe(
    filter((request) => request.method === 'progress'),
    map((request) => request.params as ProgressParams<any>),
  );

  private constructor(private readonly logger: Logger) {
    // Start the mutation server
    const workspaceConfig = vscode.workspace.getConfiguration(config.app.name);

    const mutationServerExecutablePath: string | undefined = workspaceConfig.get('mutationServerExecutablePath');

    if (!mutationServerExecutablePath) {
      logger.logError(config.errors.mutationServerExecutablePathNotSet);
      throw new Error(config.errors.mutationServerExecutablePathNotSet);
    }

    const mutationServerPort: number | undefined = workspaceConfig.get('mutationServerPort');
    const args: string[] = [];
    if (mutationServerPort) {
      args.push('--port', mutationServerPort.toString());
    }

    this.process = spawn(mutationServerExecutablePath, args, { cwd: vscode.workspace.workspaceFolders![0].uri.fsPath });

    if (this.process.pid === undefined) {
      logger.logError(
        `[Mutation Server] Failed to start mutation server with executable path: ${mutationServerExecutablePath} ` +
          `and port: ${mutationServerPort}. These properties can be configured in the extension settings, then reload the window.`,
      );
      throw new Error(config.errors.mutationServerFailed);
    }

    this.process.on('exit', (code) => {
      logger.logInfo(`[Mutation Server] Exited with code ${code}`);
    });

    this.process.stdout.on('data', (data) => {
      logger.logInfo(`[Mutation Server] ${data.toString()}`);
    });

    this.process.stderr.on('data', (data) => {
      logger.logError(`[Mutation Server] ${data.toString()}`);
    });
  }

  public static async create(logger: Logger): Promise<MutationServer> {
    const server = new MutationServer(logger);
    await server.connect();
    return server;
  }

  private async connect(): Promise<void> {
    const port = await this.waitForMutationServerStarted();
    this.connectViaWebSocket(port);

    this.rpcClient = new JSONRPCClient(async (jsonRpcRequest: JSONRPCRequest) => {
      await this.waitForOpenSocket(this.webSocket!);
      this.webSocket!.send(JSON.stringify(jsonRpcRequest));
    });
  }

  public async instrument(params: InstrumentParams): Promise<MutantResult[]> {
    return await window.withProgress(
      {
        location: ProgressLocation.Window,
        title: config.messages.instrumentationRunning,
      },
      async () => {
        if (!this.rpcClient) {
          throw new Error('Setup method not called.');
        }

        const result = await this.rpcClient.request('instrument', params);

        return result;
      },
    );
  }

  public async mutate(params: MutateParams, onPartialResult: (partialResult: MutatePartialResult) => void): Promise<void> {
    return await window.withProgress(
      {
        location: ProgressLocation.Window,
        title: config.messages.mutationTestingRunning,
        cancellable: true,
      },
      async () => {
        if (!this.rpcClient) {
          throw new Error('Setup method not called.');
        }

        this.progressNotification$
          .pipe(
            filter((progress: ProgressParams<MutatePartialResult>) => progress.token === params.partialResultToken),
            map((progress) => progress.value),
          )
          .subscribe(onPartialResult);

        await this.rpcClient.request('mutate', params);
      },
    );
  }

  private connectViaWebSocket(port: number) {
    this.webSocket = new WebSocket(`ws://localhost:${port}`);

    this.webSocket.on('message', (data: Data) => {
      let response: JSONRPCRequest | JSONRPCResponse | undefined;

      try {
        response = JSON.parse(data.toString());
      } catch (error) {
        this.logger.logError(`Error parsing JSON: ${data.toString()}`);
        return;
      }

      if (response) {
        const isNotification = !response.id;

        if (isNotification) {
          this.notification$Subject.next(response as JSONRPCRequest);
        } else {
          this.rpcClient!.receive(response as JSONRPCResponse);
        }
      }
    });

    this.webSocket.on('error', async (err) => {
      this.logger.logError(`WebSocket Error: ${err}`);
      await this.logger.errorNotification(config.errors.mutationServerFailed);
    });
  }

  private readonly waitForOpenSocket = (socket: WebSocket): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (socket.readyState !== socket.OPEN) {
        socket.on('open', () => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  };

  private readonly waitForMutationServerStarted = async (): Promise<number> => {
    return await new Promise<number>((resolve) => {
      this.process.stdout.on('data', (data) => {
        const dataString: string = data.toString();
        const port = /Server is listening on port: (\d+)/.exec(dataString);
        if (port) {
          resolve(parseInt(port[1], 10));
        }
      });
    });
  };
}
