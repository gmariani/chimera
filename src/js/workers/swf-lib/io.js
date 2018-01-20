/* See license.txt for terms of usage */

define([
	"firebug/lib/xpcom",
    "firebug/lib/trace",
],
function(Xpcom, FBTrace) {

// ********************************************************************************************* //
// Constants

var Ci = Components.interfaces;
var Cc = Components.classes;
var Cu = Components.utils;
var IOSVC = Xpcom.CCSV('@mozilla.org/network/io-service;1', 'nsIIOService');
	
var trace = function(msg, obj) {
	if (FBTrace.DBG_FLASH) FBTrace.sysout('flashbug; ' + msg, obj);
};

var IO = {};
		
// Requests that the operating system attempt to open this file.
// This is not available on all operating systems;
IO.launchFile = function(f) {
	//trace("launchFile: " + f.path + ' ' + f.launch, f);
	try {
		f.launch();
	} catch (ex) {
		trace("launchFile err", ex);
		// If launch fails, try sending it through the system's external
		var uri = IOSVC.newFileURI(f),
			_protocolSvc = Xpcom.CCSV('@mozilla.org/uriloader/external-protocol-service;1', 'nsIExternalProtocolService');
		_protocolSvc.loadUrl(uri);
	}
};
		
		// Clear and write file
IO.writeFile = function(file, string, append) {
	var success = true;
	try {
		var fos = Xpcom.CCIN('@mozilla.org/network/file-output-stream;1', 'nsIFileOutputStream');
		// ioFlags
		// -1 defaults to PR_WRONLY 0x02 | PR_CREATE_FILE 0x08 | PR_TRUNCATE 0x20
		// Flashbug Old set to PR_RDWR 0x04 | PR_CREATE_FILE 0x08 | PR_TRUNCATE 0x20
		/*
		Name			Value	Description
		PR_RDONLY		0x01	Open for reading only.
		PR_WRONLY		0x02	Open for writing only.
		PR_RDWR			0x04	Open for reading and writing.
		PR_CREATE_FILE	0x08	If the file does not exist, the file is created. If the file exists, this flag has no effect.
		PR_APPEND		0x10	The file pointer is set to the end of the file prior to each write.
		PR_TRUNCATE		0x20	If the file exists, its length is truncated to 0.
		PR_SYNC			0x40	If set, each write will wait for both the file data and file status to be physically updated.
		PR_EXCL			0x80	With PR_CREATE_FILE, if the file does not exist, the file is created. If the file already exists, no action and NULL is returned.
		*/
		
		// perm ?|Owner|Group|Other
		// -1 defaults to 0664
		// Flashbug Old set to 755
		/*
		0 --- no permission
		1 --x execute 
		2 -w- write 
		3 -wx write and execute
		4 r-- read
		5 r-x read and execute
		6 rw- read and write
		7 rwx read, write and execute
		*/
		//is.init(file, -1, -1, 0);
		// Switched back to the old style, was a permissions issue. Maybe FlashTracer was to blame?
		if (append) {
			fos.init(file, 0x02|0x08|0x10, 755, 0);
		} else {
			fos.init(file, 0x04|0x08|0x20, 755, 0);
		}
		if(string && string.length > 0) {
			fos.write(string, string.length);
		} else {
			trace('writeFile Error: String is too short or empty', string);
		}
	} catch (e) {
		trace('writeFile Error: ' + e.toString(), e);
		success = false;
	} finally {
		if (fos) {
			if (fos instanceof Ci.nsISafeOutputStream) {
				fos.finish();
			} else {
				fos.close();
			}
		}
		return success;
	}
	
	return true;
};

// ********************************************************************************************* //

return IO;

// ********************************************************************************************* //
});