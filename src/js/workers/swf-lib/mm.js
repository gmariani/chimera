/* See license.txt for terms of usage */

define([
	"firebug/lib/options",
	"firebug/lib/locale",
	"firebug/lib/xpcom",
    "firebug/lib/trace",
	"flashbug/lib/io"
],
function(Options, Locale, Xpcom, FBTrace, IO) {

// ********************************************************************************************* //
// Constants

var Ci = Components.interfaces;
var Cc = Components.classes;
var Cu = Components.utils;
	
var _playerVersion,
	_os,
	_flashPlayerDirPath,
	_logFile,
	_polFile,
	_mmDirPath,
	_mmFile,
	_mmProps;
	
var trace = function(msg, obj) {
		if (FBTrace.DBG_FLASH) FBTrace.sysout('flashbug; ' + msg, obj);
	};

var MM = {
		
		get playerVersion() {
			if (!_playerVersion) {
				_playerVersion = Locale.$STR('flashbug.noPlayer');
				
				var p = navigator.plugins['Shockwave Flash'];
				if (p) {
					if (!(typeof navigator.mimeTypes != 'undefined' && navigator.mimeTypes[Flashbug.SWF_MIME] && !navigator.mimeTypes[Flashbug.SWF_MIME].enabledPlugin)) {
						_playerVersion = this.OS.toUpperCase();
						
						// Linux does not seem to have a version number, use the description to grab it
						var versionDesc = p.description.replace('Shockwave Flash ', '');
						_playerVersion += ' ' + (p.version ? p.version : versionDesc);
						
						// Debug Player
						// Linux Beta: 'Shockwave Flash 11.2 d202' 'libflashplayer.so' 'Shockwave Flash' ''
						// Windows Debug: 'Shockwave Flash 11.0 r1' 'NPSWF32.dll' 'Shockwave Flash' '11.0.1.152'
						// Linux Debug: 'Shockwave Flash 11.0 r1' 'npwrapper.libflashplayer.so' 'Shockwave Flash' ''
						// Shockwave Flash 10.3 d180 - Shockwave Flash 10.2 r154
						if (p.description.match(' d') || p.description.match(' r')) _playerVersion += ' ' + Locale.$STR('flashbug.debugVersion');
					}
				}
			}
			
			return _playerVersion;
		},
		
		// Get the running operating system
		get OS() {
			if(!_os) {
				var agt = navigator.userAgent.toLowerCase();
				// CCSV('@mozilla.org/xre/app-info;1', 'Ci.nsIXULRuntime').OS
				// Inaccurate, OSX = Darwin, XP AND Vista = WINNT
				if(agt.indexOf('win') != -1) {
					if(agt.indexOf('windows nt 6') != -1) {
						_os = 'winVista';
					} else {
						_os = 'win';
					}
				} else if(agt.indexOf('macintosh') != -1) {
					_os = 'mac';
				} else {
					_os = 'linux';
				}
			}
			
			return _os;
		},
		
		// Get the Flash Player directory depending on OS
		get flashPlayerDirectory() {
			var file, 
				dir = Xpcom.CCIN('@mozilla.org/file/directory_service;1', 'nsIProperties');
			if(!_flashPlayerDirPath) {
				switch(this.OS) {
					case 'win' :
					case 'winVista' :
						// C:\Documents and Settings\<user>\Application Data
						// C:\Users\<user>\AppData\Roaming
						file = dir.get('AppData', Ci.nsILocalFile);
						file.append('Macromedia');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						file.append('Flash Player');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						break;
					case 'mac' :
						// /User/<user>/Library/Preferences
						file = dir.get('UsrPrfs', Ci.nsILocalFile);
						file.append('Macromedia');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						file.append('Flash Player');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						break;
					case 'linux' :
						// /home/<user>
						file = dir.get('Home', Ci.nsILocalFile);
						file.append('.macromedia');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						//file.append('Macromedia');
						file.append('Flash_Player');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						break;
				}
				
				_flashPlayerDirPath = file.path;
			} else {
				file = Xpcom.CCIN('@mozilla.org/file/local;1', 'nsILocalFile');
				file.initWithPath(_flashPlayerDirPath);
			}
			
			return file;
		},
		
		// ************************************************************************************************
		// Trust File
		/*
		Windows all users:
		<system>\Macromed\Flash\FlashPlayerTrust (c:\WINDOWS\system32\Macromed\Flash\FlashPlayerTrust)
		
		Windows single user:
		<app data>\Macromedia\Flash Player\#Security\FlashPlayerTrust 
		Win XP (c:\Documents and Settings\<user>\Application Data\Macromedia\Flash Player\#Security\FlashPlayerTrust)
		Win Vista (c:\Users\<user>\AppData\Roaming\Macromedia\Flash Player\#Security\FlashPlayerTrust)
		
		Mac OS all users:
		<app support>/Macromedia/FlashPlayerTrust (/Library/Application Support/Macromedia/FlashPlayerTrust)
		
		Mac OS single user:
		<app data>/Macromedia/Flash Player/#Security/FlashPlayerTrust (/Users/<user>/Library/Preferences/Macromedia/Flash Player/#Security/FlashPlayerTrust)
		
		Linux all users:
		/etc/adobe/FlashPlayerTrust/
		
		Linux single user:
		/home/<user>/.macromedia/Flash_Player/#Security/FlashPlayerTrust
		/home/<user>/.macromedia/Macromedia/Flash_Player/#Security/FlashPlayerTrust/
		*/
		
		get trustFile() {
			var file = this.flashPlayerDirectory;
			file.append('#Security');
			if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
			file.append('FlashPlayerTrust');
			if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
			file.append('flashbug.cfg');
			return file;
		},
		
		get trustPath() {
			var profDir = Xpcom.CCIN('@mozilla.org/file/directory_service;1', 'nsIProperties').get('ProfD', Ci.nsILocalFile);
			profDir.append('extensions');
			profDir.append('flashbug@coursevector.com');
			profDir.append('chrome');
			return profDir.path;
		},
		
		checkTrustFile: function() {
			var file = this.trustFile;
			var path = this.trustPath;
			var hasPath = false;
			
			try {
				if (file.exists && file.fileSize != 0) {
					// read lines into array
					var str = '',
						fis = Xpcom.CCIN('@mozilla.org/network/file-input-stream;1', 'nsIFileInputStream'),
						line = {}, 
						lines = [], 
						hasmore = null;
					fis.init(file, 0x01, 4, null);
					Xpcom.QI(fis, Ci.nsILineInputStream); 
					do {
						hasmore = fis.readLine(line);
						lines.push(line.value); 
					} while(hasmore);
					fis.close();
					
					var i = lines.length;
					while (i--) {
						var idx = lines[i].indexOf(path);
						if (idx > -1) hasPath = true;
						if (hasPath) break;
					}
				}
			} catch(e) {
				trace('checkTrustFile Error: ' + e.toString(), e);
				return hasPath;
			}
			
			return hasPath;
		},
		
		saveTrustFile: function() {
			var file = this.trustFile;
			var path = this.trustPath;
			if (file.size != 0) path = '\n' + path;
			
			// Work with multiple profiles
			IO.writeFile(file, path, true);
		},
		
		// ************************************************************************************************
		// Log Files
		
		/*
		 Windows XP: C:\Documents and Settings\<user>\Application Data\Macromedia\Flash Player\Logs\flashlog.txt
		 Windows Vista: C:\Users\<user>\AppData\Roaming\Macromedia\Flash Player\Logs\flashlog.txt
		 OSX: /Users/<user>/Library/Preferences/Macromedia/Flash Player/Logs/flashlog.txt
		 Linux: home/<user>/.macromedia/Flash_Player/Logs/flashlog.txt
		*/
		
		get logFile() {
			if(!_logFile || !_logFile.exists()) {
				_logFile = this.flashPlayerDirectory;
				_logFile.append('Logs');
				if(!_logFile.exists() || !_logFile.isDirectory()) _logFile.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
				_logFile.append('flashlog.txt');
				if(!_logFile.exists()) _logFile.create(Ci.nsILocalFile.NORMAL_FILE_TYPE, 777);
			}
			
			return _logFile;
		},
		
		get policyFile() {
			if(!_polFile || !_polFile.exists()) {
				_polFile = this.flashPlayerDirectory;
				_polFile.append('Logs');
				if(!_polFile.exists() || !_polFile.isDirectory()) _polFile.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
				_polFile.append('policyfiles.txt');
				if(!_polFile.exists()) _polFile.create(Ci.nsILocalFile.NORMAL_FILE_TYPE, 777);
			}
			
			return _polFile;
		},
		
		// ************************************************************************************************
		// SWF Profiler
		
		get profilerPath() {
			var profDir = Xpcom.CCIN('@mozilla.org/file/directory_service;1', 'nsIProperties').get('ProfD', Ci.nsILocalFile);
			profDir.append('extensions');
			profDir.append('flashbug@coursevector.com');
			profDir.append('chrome');
			profDir.append('content');
			profDir.append('flashbug');
			profDir.append('profiler.swf');
			return profDir.path;
		},
		
		// ************************************************************************************************
		// MM File
		
		get MM_PROPS() {
			var t = this;
			if (!_mmProps) {
				_mmProps = [
					{ name:'AllowUserLocalTrust', 		type:'bool', default:true, documented:true },
					{ name:'AS3AllocationTracking', 	type:'bool' },
					{ name:'AS3AutoStartSampling', 		type:'bool' },
					{ name:'AS3CSE', 					type:'bool' },
					{ name:'AS3DCE', 					type:'bool' },
					{ name:'AS3DynamicProfile', 		type:'bool' },
					{ name:'AS3MIR', 					type:'bool' },
					{ name:'AS3Sampling', 				type:'bool' },
					{ name:'AS3SSE', 					type:'bool' },
					{ name:'AS3StaticProfile', 			type:'bool' },
					{ name:'AS3Trace', 					type:'bool' },
					{ name:'AS3Turbo', 					type:'bool' },
					{ name:'AS3Verbose', 				type:'bool' },
					{ name:'AssetCacheSize', 			type:'int', default:20, documented:true },
					{ name:'AutoUpdateDisable', 		type:'bool', default:false, documented:true }, 
					{ name:'AutoUpdateInterval', 		type:'int', default:-1, documented:true },
					{ name:'AutoUpdateVersionUrl', 		type:'string' },
					{ name:'AVHardwareDisable', 		type:'bool', default:false, documented:true },
					{ name:'AVHardwareEnabledDomain', 	type:'string', documented:true }, // can have multiple
					{ name:'CodeSignLogFile', 			type:'string' },
					{ name:'CodeSignRootCert', 			type:'bool' },
					{ name:'Convert8kAnd16kAudio', 		type:'bool' },
					{ name:'CrashLogEnable',			type:'bool' },
					{ name:'DisableAVM1Loading', 		type:'bool' },
					{ name:'DisableDeviceFontEnumeration', type:'bool', default:false, documented:true },
					{ name:'DisableIncrementalGC', 		type:'bool' },
					{ name:'DisableMulticoreRenderer', 	type:'bool' },
					{ name:'DisableNetworkAndFilesystemInHostApp', type:'string', documented:true },
					{ name:'DisableProductDownload', 	type:'bool', default:false, documented:true },
					{ name:'DisableSockets', 			type:'bool', documented:true },
					{ name:'DisplayGPUBlend', 			type:'bool' },
					{ name:'EnableIncrementalValidation', type:'bool' },
					{ name:'EnableLeakFile', 			type:'bool' },
					{ name:'EnableSocketsTo', 			type:'string', documented:true }, // can have multiple
					{ name:'EnforceLocalSecurityInActiveXHostApp', type:'string', documented:true },
					{ name:'ErrorReportingEnable', 		type:'bool', default:false, documented:true },
					{ name:'FileDownloadDisable', 		type:'bool', default:false, documented:true },
					{ name:'FileDownloadEnabledDomain', type:'string', documented:true }, // can have multiple
					{ name:'FileUploadDisable', 		type:'bool', default:false, documented:true },
					{ name:'FileUploadEnabledDomain', 	type:'string', documented:true }, // can have multiple
					{ name:'ForceGPUBlend', 			type:'bool' },
					{ name:'FrameProfilingEnable', 		type:'bool' },
					{ name:'FullScreenDisable', 		type:'bool', default:false, documented:true },
					{ name:'GCStats', 					type:'bool' },
					{ name:'GPULogOutputFileName', 		type:'string' },
					{ name:'HeapProfilingAS3Enable', 	type:'bool'},
					{ name:'LegacyDomainMatching',		type:'bool', documented:true },
					{ name:'LocalFileLegacyAction', 	type:'bool', documented:true },
					{ name:'LocalFileReadDisable', 		type:'bool', default:false, documented:true },
					{ name:'LocalStorageLimit', 		type:'int', default:6, documented:true },
					{ name:'LogGPU', 					type:'bool' },
					{ name:'MaxWarnings', 				type:'int', default:100, documented:true },
					{ name:'OverrideGPUValidation', 	type:'bool', documented:true  },
					{ name:'OverrideUserInvokedActions', type:'bool'  },
					{ name:'PolicyFileLog', 			type:'bool', default:true, documented:true  }, // default is false
					{ name:'PolicyFileLogAppend', 		type:'bool', default:true, documented:true }, // default is false
					{ name:'PreloadSwf', 				type:'string' },
					{ name:'ProductDisabled', 			type:'string', documented:true }, // can have multiple
					{ name:'ProductDownloadBaseUrl', 	type:'string' },
					{ name:'ProfileFunctionEnable', 	type:'bool' },
					{ name:'ProfilingOutputDirectory', 	type:'string' },
					{ name:'ProfilingOutputFileEnable', type:'bool' },
					{ name:'RendererProfilingEnable', 	type:'bool' },
					{ name:'RTMFPP2PDisable', 			type:'bool', documented:true },
					{ name:'RTMFPTURNProxy', 			type:'string', documented:true },
					{ name:'ScriptStuckTimeout', 		type:'int', documented:true },
					{ name:'SecurityDialogReportingEnable', type:'bool' },
					{ name:'SuppressDebuggerExceptionDialogs', type:'bool' },
					{ name:'ThirdPartyStorage', 		type:'bool', documented:true }, // no default
					{ name:'TraceOutputBuffered', 		type:'bool' },
					{ name:'TraceOutputFileEnable', 	type:'bool', default:true, documented:true },// default is false
					{ name:'TraceOutputFileName', 		type:'string', default:t.logFile.path, documented:true },
					{ name:'UseBrokerProcess', 			type:'bool' },
					{ name:'WindowlessDisable', 		type:'bool' }
				];
			}
			return _mmProps;
		},
		
		get mmDirectory() {
			var file = undefined,
				dir = Xpcom.CCIN('@mozilla.org/file/directory_service;1', 'nsIProperties'),
				useGlobalVariables = Options.get('flashbug.useGlobalVariables');
			if(!_mmDirPath) {
				switch(this.OS) {
					case 'win' :
						// Normally we would use Home here, but at my work we have it mapped to something else. So this manually figures it out.
						// C:\Documents and Settings\<user>
						// get('Home', Ci.nsILocalFile) - H:\ (What my work has it mapped to) C:\Documents and Settings\<user> (What it should be)
						// get('Pers', Ci.nsILocalFile) - C:\Documents and Settings\<user>\My Documents
						// get('Desk', Ci.nsILocalFile) - C:\Documents and Settings\<user>\Desktop
						// get('AppData', Ci.nsILocalFile) - C:\Documents and Settings\<user>\Application Data : C:\Users\<user>\AppData\Roaming
						
						if (useGlobalVariables) {
							file = dir.get('Home', Ci.nsILocalFile);
						} else {
							file = dir.get('AppData', Ci.nsILocalFile).parent;
						}
						break;
					case 'winVista' :
						// C:\Users\<user>
						// get('Home', Ci.nsILocalFile) - C:\Users\<user>
						// get('Pers', Ci.nsILocalFile) - C:\Users\<user>\Documents
						// get('Desk', Ci.nsILocalFile) - C:\Users\<user>\Desktop
						// get('AppData', Ci.nsILocalFile) - C:\Users\<user>\AppData\Roaming
						if (useGlobalVariables) {
							file = dir.get('Home', Ci.nsILocalFile);
						} else {
							file = dir.get('AppData', Ci.nsILocalFile).parent.parent;
						}
						break;
					case 'mac' :
						// On Mac OS X, Flash Player now looks for the mm.cfg file in your home directory(~), generally, /Users/<user>.
						// If one is not found, it looks for mm.cfg in /Library/Application Support/Macromedia. 
						// For previous versions of Flash Player, Flash Player ignored an mm.cfg file in your home directory /Users/<user>. 
						// For some users with an mm.cfg in their home directory, tracing to the flashlog.txt file will not work.
						
						// /Library/Application Support/Macromedia
						file = dir.get('LocDsk', Ci.nsILocalFile).parent;
						file.append('Application Support');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						file.append('Macromedia');
						if(!file.exists() || !file.isDirectory()) file.create(Ci.nsILocalFile.DIRECTORY_TYPE, 777);
						
						// /Users/<user>
						//file = dir.get('Home', Ci.nsILocalFile);
						break;
					case 'linux' :
						// /home/<user>
						// get('Home', Ci.nsILocalFile) - /home/<user>
						// get('Pers', Ci.nsILocalFile) - null
						// get('Desk', Ci.nsILocalFile) - /home/<user>/Desktop
						// get('AppData', Ci.nsILocalFile) - null
						file = dir.get('Home', Ci.nsILocalFile);
						break;
				}
				
				_mmDirPath = file.path;
			} else {
				file = Xpcom.CCIN('@mozilla.org/file/local;1', 'nsILocalFile');
				file.initWithPath(_mmDirPath);
			}
			
			return file;
		},
		
		get mmFile() {
			if(!_mmFile || !_mmFile.exists()) {
				_mmFile = this.mmDirectory;
				_mmFile.append('mm.cfg');
				if(!_mmFile.exists()) _mmFile.create(Ci.nsILocalFile.NORMAL_FILE_TYPE, 777);
			}
			
			return _mmFile;
		},
		
		initMMFile: function(force) {
			var mm_exists = true,
				alertTimer = Xpcom.CCIN('@mozilla.org/timer;1', 'nsITimer'),
				alertDelay = 3000;
			
			var settings = this.readMMFile();
			if(this.mmFile.fileSize == 0 || force) {
				if(this.mmDirectory.isWritable()) {
					var result = this.saveMMFile(settings);
					if(result != true) {
						// Cannot create the Flash Player Debugger config (mm.cfg) file in
						alertTimer.initWithCallback({ notify:function(timer) { _alert(Locale.$STR("flashbug.logPanel.error.mm") + this.mmFile.path); } }, alertDelay, Ci.nsITimer.TYPE_ONE_SHOT);
						mm_exists = false;
					} else {
						mm_exists = true;
						// Flash Player Debugger config (mm.cfg) file created for the first time.
						//alertTimer.initWithCallback({ notify:function(timer) { _alert($FL_STR("flashbug.logPanel.mmCreate")); } }, alertDelay, Ci.nsITimer.TYPE_ONE_SHOT);
					}
				} else {
					// is not writeable, please check permissions
					alertTimer.initWithCallback({ notify:function(timer) { _alert(this.mmDirectory.path + Locale.$STR("flashbug.logPanel.error.write")); } }, alertDelay, Ci.nsITimer.TYPE_ONE_SHOT);
					mm_exists = false;
				}
			}
			
			if(!mm_exists) {
				//Flash Player Debugger config (mm.cfg) file does not exist
				alertTimer.initWithCallback({ notify:function(timer) { _alert(Locale.$STR("flashbug.logPanel.error.mm2")); } }, alertDelay, Ci.nsITimer.TYPE_ONE_SHOT);
			}
			
			// Update settings based on whats actually in the mm.cfg file
			settings = this.readMMFile();
			for (var prop in settings) {
				Options.set('flashbug.' + prop, settings[prop]);
			}
		},
		
		/*
		Mac OSX: Flash Player first checks the user's home directory (~). If none is found, then Flash Player looks in /Library/Application Support/Macromedia
		Windows 95/98/ME: %HOMEDRIVE%\%HOMEPATH%
		Windows 2000/XP: C:\Documents and Settings\username
		Windows Vista: C:\Users\username
		Linux: /home/username
		*/
		saveMMFile: function(mm) {
			if (!mm) mm = {};
			
			try {
				// Set preloadSWF based on Flash Panel being enabled
				//var path = 'D:\\SVN\\projects\\firefox\\flashbug\\profiler\\profiler.swf';
				//var path = 'C:\\Users\\Gabriel\\Documents\\SVN\\Coursevector\\projects\\firefox\\flashbug\\profiler\\profiler.swf';
				var path = this.profilerPath;
				if (Options.get('flbInspector.enableSites') == true) {
					mm.PreloadSwf = path;
				} else {
					// Only mess with this if it's the built in path, not custom
					if (mm.hasOwnProperty('PreloadSwf') && mm.PreloadSwf == path) mm.PreloadSwf = '';
				}
				
				var str = '';
				for (var i = 0; i < this.MM_PROPS.length; i++) {
					var prop = this.MM_PROPS[i];
					var value = null;
					if (mm.hasOwnProperty(prop.name)) {
						value = mm[prop.name];
					} else if (prop.hasOwnProperty('default')) {
						value = prop.default;
					}
					
					if (value == null) continue;
					if (typeof value == 'boolean') {
						str += '\n' + prop.name + '=' + (value == true ? '1' : '0');
					} else {
						if (prop.type == 'int') {
							str += '\n' + prop.name + '=' + parseInt(value);
						} else {
							// TODO if array, do prop multiple times
							str += '\n' + prop.name + '=' + value;
						}
					}
				}
				
				return IO.writeFile(this.mmFile, str);
			} catch (e) {
				trace('saveMMFile Error: ' + e.toString(), e);
				return false;
			}
		},
		
		readMMFile: function() {
			var file = this.mmFile,
				o = {};
			try {
				if(file.exists && file.fileSize != 0) {
					var str = '',
						fis = Xpcom.CCIN('@mozilla.org/network/file-input-stream;1', 'nsIFileInputStream'),
						cis = Xpcom.CCIN('@mozilla.org/intl/converter-input-stream;1', 'nsIConverterInputStream');
					fis.init(file, 0x01, 4, null);
					cis.init(fis, 'UTF-8', 1024, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
					if(cis instanceof Ci.nsIUnicharLineInputStream) {
						var data = {},
						read = 0;
						do { 
							read = cis.readString(0xFFFFFFFF, data); // read as much as we can and put it in str.value
							str += data.value;
						} while (read != 0);
						
						cis.close();
					}
					fis.close();
					
					for (var i = 0; i < this.MM_PROPS.length; i++) {
						var prop = this.MM_PROPS[i], regex, result;
						// { name:'ProductDisabled', type:'bool' }
						
						switch(prop.type) {
							case 'bool' :
								regex = new RegExp("^" + prop.name + "=([01])", "gm");
								result = regex.exec(str);
								if (result)	o[prop.name] = Boolean(result[1] == 1);
								break;
							case 'int' :
								regex = new RegExp("^" + prop.name + "=(\\d+)", "gm");
								result = regex.exec(str);
								if (result)	o[prop.name] = +result[1];
								break;
							case 'string' :
							default :
								regex = new RegExp("^" + prop.name + "=([^#\\r\\n]+)", "gm");
								result = regex.exec(str);
								if (result)	o[prop.name] = result[1];
								break;
						}
					}
				}
			} catch(e) {
				trace('readMMFile Error: ' + e.toString(), e);
			}
			
			return o;
		}
};

// ********************************************************************************************* //

MM.initMMFile(true);

return MM;

// ********************************************************************************************* //
});