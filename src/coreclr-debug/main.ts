/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import TelemetryReporter from 'vscode-extension-telemetry';
import CoreClrDebugUtil from './util'

let _channel: vscode.OutputChannel;
let _installLog: NodeJS.WritableStream;
let _reporter: TelemetryReporter; // Telemetry reporter
let _util: CoreClrDebugUtil;

export function activate(context: vscode.ExtensionContext, reporter: TelemetryReporter) {    
    _util = new CoreClrDebugUtil(context.extensionPath);
    
    if (CoreClrDebugUtil.existsSync(_util.installCompleteFilePath())) {
        console.log('.NET Core Debugger tools already installed');
        return;
    }
    
    if (!isOnPath('dotnet')) {
        const getDotNetMessage = "Get .NET CLI tools"; 
        vscode.window.showErrorMessage("The .NET CLI tools cannot be located. .NET Core debugging will not be enabled. Make sure .NET CLI tools are installed and are on the path.",
            getDotNetMessage).then(function (value) {
                if (value === getDotNetMessage) {
                    let open = require('open');
                    open("http://dotnet.github.io/getting-started/");
                }
            });
            
        return;
    }
    
    _reporter = reporter;
    _channel = vscode.window.createOutputChannel('coreclr-debug');
    
    // Create our log file and override _channel.append to also output to the log
    _installLog = fs.createWriteStream(_util.installLogPath());
    (function() {
        let proxied = _channel.append;
        _channel.append = function(val: string) {
            _installLog.write(val);
            proxied.apply(this, arguments);
        };
    })();

    let statusBarMessage = vscode.window.setStatusBarMessage("Downloading and configuring the .NET Core Debugger...");
       
    let installStage = 'installBegin';
    let installError = '';
    
    writeInstallBeginFile().then(function() {
        installStage = 'dotnetRestore'
        return spawnChildProcess('dotnet', ['--verbose', 'restore', '--configfile', 'NuGet.config'], _channel, _util.coreClrDebugDir())  
    }).then(function() {
        installStage = "dotnetPublish";
        return spawnChildProcess('dotnet', ['--verbose', 'publish', '-o', _util.debugAdapterDir()], _channel, _util.coreClrDebugDir());
    }).then(function() {
        installStage = "ensureAd7";
        return ensureAd7EngineExists(_channel, _util.debugAdapterDir());
    }).then(function() {
        installStage = "additionalTasks";
        let promises: Promise<void>[] = [];

        promises.push(renameDummyEntrypoint());
        promises.push(removeLibCoreClrTraceProvider());

        return Promise.all(promises);
    }).then(function() {
        installStage = "rewriteManifest";
        rewriteManifest();
        installStage = "writeCompletionFile";
        return writeCompletionFile();
    }).then(function() {
        installStage = "completeSuccess";
        statusBarMessage.dispose();
        vscode.window.setStatusBarMessage('Successfully installed .NET Core Debugger.');
    })
    .catch(function(error) {
        const viewLogMessage = "View Log";
        vscode.window.showErrorMessage('Error while installing .NET Core Debugger.', viewLogMessage).then(function (value) {
            if (value === viewLogMessage) {
                _channel.show(vscode.ViewColumn.Three);
            }
        });
        statusBarMessage.dispose();
        
        installError = error.toString();
        console.log(error);
        
        
    }).then(function() {
        // log telemetry and delete install begin file
        logTelemetry('Acquisition', {installStage: installStage, installError: installError});
        
        try {
            deleteInstallBeginFile();
        } catch (err) {
            // if this throws there's really nothing we can do
        }
    });
}

function logTelemetry(eventName: string, properties?: {[prop: string]: string}) {
    if (_reporter)
    {
        _reporter.sendTelemetryEvent('coreclr-debug/' + eventName, properties);
    }
}

function rewriteManifest() : void {
    const manifestPath = path.join(_util.extensionDir(), 'package.json');
    let manifestString = fs.readFileSync(manifestPath, 'utf8');
    let manifestObject = JSON.parse(manifestString);
    manifestObject.contributes.debuggers[0].runtime = '';
    manifestObject.contributes.debuggers[0].program = './coreclr-debug/debugAdapters/OpenDebugAD7' + CoreClrDebugUtil.getPlatformExeExtension();
    manifestString = JSON.stringify(manifestObject, null, 2);
    fs.writeFileSync(manifestPath, manifestString);
}

function writeInstallBeginFile() : Promise<void> {
    return writeEmptyFile(_util.installBeginFilePath());
}

function deleteInstallBeginFile() {
    if (CoreClrDebugUtil.existsSync(_util.installBeginFilePath())) {
        fs.unlinkSync(_util.installBeginFilePath());
    }
}

function writeCompletionFile() : Promise<void> {
    return writeEmptyFile(_util.installCompleteFilePath());
}

function writeEmptyFile(path: string) : Promise<void> {
    return new Promise<void>(function(resolve, reject) {
       fs.writeFile(path, '', function(err) {
          if (err) {
              reject(err.code);
          } else {
              resolve();
          }
       });
    });
}

function renameDummyEntrypoint() : Promise<void> {
    let src = path.join(_util.debugAdapterDir(), 'dummy');
    let dest = path.join(_util.debugAdapterDir(), 'OpenDebugAD7');

    src += CoreClrDebugUtil.getPlatformExeExtension();
    dest += CoreClrDebugUtil.getPlatformExeExtension();

    const promise = new Promise<void>(function(resolve, reject) {
       fs.rename(src, dest, function(err) {
           if (err) {
               reject(err.code);
           } else {
               resolve();
           }
       });
    });
    
    return promise;
}

function removeLibCoreClrTraceProvider() : Promise<void>
{
    const filePath = path.join(_util.debugAdapterDir(), 'libcoreclrtraceptprovider' + CoreClrDebugUtil.getPlatformLibExtension());

    if (!CoreClrDebugUtil.existsSync(filePath)) {
        return Promise.resolve();
    } else {
        return new Promise<void>(function(resolve, reject) {
            fs.unlink(filePath, function(err) {
                if (err) {
                    reject(err.code);
                } else {
                    _channel.appendLine('Succesfully deleted ' + filePath);
                    resolve();
                }
            });
        });
    }
}

// Determines if the specified command is in one of the directories in the PATH environment variable.
function isOnPath(command : string) : boolean {
    let pathValue = process.env['PATH'];
    if (!pathValue) {
        return false;
    }
    let fileName = command;
    let seperatorChar = ':';
    if (process.platform == 'win32') {
        // on Windows, add a '.exe', and the path is semi-colon seperatode
        fileName = fileName + ".exe";
        seperatorChar = ';';   
    }
    
    let pathSegments: string[] = pathValue.split(seperatorChar);
    for (let segment of pathSegments) {
        if (segment.length === 0 || !path.isAbsolute(segment)) {
            continue;
        }
        
        const segmentPath = path.join(segment, fileName);
        if (CoreClrDebugUtil.existsSync(segmentPath)) {
            return true;
        }
    }
    
    return false;
}

function ensureAd7EngineExists(channel: vscode.OutputChannel, outputDirectory: string) : Promise<void> {
    let filePath = path.join(outputDirectory, "coreclr.ad7Engine.json");
    return new Promise<void>((resolve, reject) => {
        fs.exists(filePath, (exists) => {
            if (exists) {
                return resolve();
            } else {
                channel.appendLine(`${filePath} does not exist.`);
                channel.appendLine('');
                // NOTE: The minimum build number is actually less than 1584, but this is the minimum
                // build that I have tested.
                channel.appendLine("Error: The .NET CLI did not correctly restore debugger files. Ensure that you have .NET CLI version 1.0.0 build #001584 or newer. You can check your .NET CLI version using 'dotnet --version'.");
                return reject("The .NET CLI did not correctly restore debugger files.");
            }
        });
    });
}

function spawnChildProcess(process: string, args: string[], channel: vscode.OutputChannel, workingDirectory: string) : Promise<void> {
    const promise = new Promise<void>(function(resolve, reject) {
        const child = child_process.spawn(process, args, {cwd: workingDirectory});

        child.stdout.on('data', (data) => {
            channel.append(`${data}`);
        });

        child.stderr.on('data', (data) => {
            channel.appendLine(`Error: ${data}`);
        });

        child.on('close', (code: number) => {
            if (code != 0) {
                channel.appendLine(`${process} exited with error code ${code}`);
                reject(new Error(code.toString()));    
            }
            else {
                resolve();
            }
        });
    });

    return promise;
}