import * as vscode from 'vscode';
import { exec, ExecException } from 'child_process';



function findRecursiveInCollection(tests: vscode.TestItemCollection, id: string): vscode.TestItem | undefined {
	for (const test of tests) {
		if (test[0] === id) {
			return test[1];
		}

		const result = findRecursiveInCollection(test[1].children, id);
		if (result) {
			return result;
		}
	}
	return undefined;
}

function findRecursive(tests: vscode.TestItem[], id: string): vscode.TestItem | undefined {
	for (const test of tests) {
		if (test.id === id) {
			return test;
		}
		const result = findRecursiveInCollection(test.children, id);
		if (result) {
			return result;
		}
	}
	return undefined;
}

export function activate(context: vscode.ExtensionContext) {

	const controller = vscode.tests.createTestController('stryker-mutator', 'Stryker Mutator');


	async function runHandler(
		shouldDebug: boolean,
		request: vscode.TestRunRequest,
		token: vscode.CancellationToken
	) {
		const run = controller.createTestRun(request);
		const queue: vscode.TestItem[] = [];

		if (request.include) {
			request.include.forEach(test => queue.push(test));
		} else {
			controller.items.forEach(test => queue.push(test));
		}

		controller.invalidateTestResults();

		while (queue.length > 0 && !token.isCancellationRequested) {
			const test = queue.pop()!;

			let command = "npx stryker run";

			let type;

			if (test.range) {
				command += ` --mutate ${test.uri?.path}:${test.range.start.line + 1}:` +
					`${test.range.start.character}-${test.range.end.line + 1}:${test.range.end.character + 1}`;

				type = "mutation";
			} else {
				command += ` --mutate ${test.uri?.path}`;

				type = "file";


				test.children.forEach((child) => {
					child.busy = true;
				});
			}

			test.busy = true;
			console.log(command);

			const util = require('util');
			const exec = util.promisify(require('child_process').exec);

			const start = Date.now();

			const { stdout, stderr } = await exec(command, { cwd: vscode.workspace.workspaceFolders![0].uri.fsPath });
			console.log(stdout);

			const mutationReport = await readMutationReport(vscode.Uri.file(`${vscode.workspace.workspaceFolders![0].uri.fsPath}/reports/mutation/mutation.json`));

			const testsFromReport: vscode.TestItem[] = readTestsFromMutationReport(mutationReport);

			if (type === "mutation") {
				const reportTestItem = findRecursive(testsFromReport, test.id);
				if (reportTestItem) {
					test.error = undefined;
					if (reportTestItem.description === 'Killed') {
						run.passed(test, Date.now() - start);
					} else {

						run.failed(test, new vscode.TestMessage("test failed (TODO: details)"), Date.now() - start);

					}
				} else {
					run.appendOutput(`Mutation not found at specified location, please re-run file. Mutation: ${test.id}\n`);

					test.error = `Mutation not found at specified location, please re-run file.`;
				}
			} else {
				// test item is a file

				testsFromReport[0].children.forEach((testFromReport) => {
					const testItem = findRecursiveInCollection(test.children, testFromReport.id);

					if (testItem) {
						if (testFromReport.description === 'Killed') {
							run.passed(testItem, Date.now() - start);
						} else {
							run.failed(testItem, new vscode.TestMessage("test failed (TODO: details)"), Date.now() - start);
						}
						testItem.busy = false;
					} else {
						test.children.delete(testFromReport.id);
						test.children.add(testFromReport);
					}
				});
			}

			test.busy = false;
		}

		run.end();
	}


	controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => {
		runHandler(false, request, token);
	});

	const readMutationReport = async (file: vscode.Uri) => {
		const contents = await vscode.workspace.fs.readFile(file);
		return JSON.parse(contents.toString());
	};

	const readTestsFromMutationReport = (mutationReport: any) => {
		const tests: vscode.TestItem[] = [];
		for (const fileName in mutationReport.files) {

			const file = mutationReport.files[fileName];

			const folderTestItem = controller.createTestItem(fileName, fileName, vscode.Uri.file(`${vscode.workspace.workspaceFolders![0].uri.fsPath}/${fileName}`));

			for (const mutant of file.mutants) {

				const fileUri = vscode.Uri.file(`${vscode.workspace.workspaceFolders![0].uri.fsPath}/${fileName}`);

				const mutantId = `${mutant.mutatorName}(${mutant.location.start.line}:${mutant.location.start.column}-${mutant.location.end.line}:${mutant.location.end.column}) (${mutant.replacement})`;

				let testItem = controller.createTestItem(mutantId, `${mutant.mutatorName} (${mutant.location.start.line}:${mutant.location.start.column})`, fileUri);
				testItem.range = new vscode.Range(
					new vscode.Position(mutant.location.start.line - 1, mutant.location.start.column - 1),
					new vscode.Position(mutant.location.end.line - 1, mutant.location.end.column - 1)
				);
				testItem.description = `${mutant.status}`;
				testItem.canResolveChildren = false;
				// testItem.sortText = undefined;

				folderTestItem.children.add(testItem);
			}

			tests.push(folderTestItem);
		}
		return tests;
	};

	context.subscriptions.push(vscode.commands.registerCommand('stryker-mutator.loadJsonToTestExplorer', async file => {
		const mutationReport = await readMutationReport(file);

		const tests = readTestsFromMutationReport(mutationReport);

		controller.items.replace(tests);

		const run = controller.createTestRun(
			new vscode.TestRunRequest(),
			'stryker-mutator',
			true
		);


		for (const fileName in mutationReport.files) {

			const file = mutationReport.files[fileName];

			for (const mutant of file.mutants) {

				const mutantId = `${mutant.mutatorName}(${mutant.location.start.line}:${mutant.location.start.column}-${mutant.location.end.line}:${mutant.location.end.column}) (${mutant.replacement})`;

				const testItem = controller.items.get(fileName)?.children.get(mutantId);

				if (!testItem) { continue; }

				if (mutant.status === 'Killed') {
					run.passed(testItem);
				} else {
					const message = new vscode.TestMessage(`${mutant.mutatorName} (${mutant.location.start.line}:${mutant.location.start.column}) ${mutant.status}`);

					await vscode.workspace.fs.readFile(vscode.Uri.file(`${vscode.workspace.workspaceFolders![0].uri.fsPath}/${fileName}`)).then((contents) => {

						const lines = contents.toString().split('\n');
						const startLine = mutant.location.start.line - 1;
						const endLine = mutant.location.end.line - 1;

						let code = lines.slice(startLine, endLine + 1).join('\n');
						const startColumn = mutant.location.start.column - 1;
						const endColumn = mutant.location.end.column - 1;

						code = code.substring(startColumn, endColumn);
						message.expectedOutput = code;
						message.actualOutput = mutant.replacement;
						message.contextValue = "singleTest";

						run.failed(testItem, message);
					});

				}
			}
		}

		run.end();

		vscode.window.showInformationMessage('Mutation tests loaded');
	}));


	const runAllTestsCommandHandler = () => {
		// vscode.commands.executeCommand('stryker-mutator.loadJsonReport',
		// 	vscode.Uri.file(`${vscode.workspace.workspaceFolders![0].uri.fsPath}/reports/mutation/mutation.json`));


		if (!vscode.workspace.workspaceFolders) {
			vscode.window.showErrorMessage('No workspace is open');
			return;
		}

		// all of these paths work
		const command = `${vscode.workspace.workspaceFolders[0].uri.fsPath}/node_modules/.bin/stryker run`;
		const command2 = `npx stryker run`;
		const command3 = `./node_modules/.bin/stryker run`;

		vscode.window.showInformationMessage('Running mutation tests...');

		exec(command2, { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath },
			(error: ExecException | null, stdout: string, stderr: string) => {
				if (error) {
					console.log(`Error executing command: ${error.message}`);
					return;
				}
				if (stderr) {
					console.log(`Command stderr: ${stderr}`);
					return;
				}
				console.log(stdout);

				vscode.commands.executeCommand('stryker-mutator.loadJsonToTestExplorer',
					vscode.Uri.file(`${vscode.workspace.workspaceFolders![0].uri.fsPath}/reports/mutation/mutation.json`));
			});
	};



	context.subscriptions.push(vscode.commands.registerCommand("stryker-mutator.runOnWorkspace", runAllTestsCommandHandler));


	context.subscriptions.push(vscode.commands.registerCommand('stryker-mutator.runOnSelection', async ({ message, test }) => {
		console.log();
	}));
}

export function deactivate() { }
