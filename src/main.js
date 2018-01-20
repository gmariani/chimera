import {ready, $} from './js/modules/toolbox-common';
import {addClass, removeClass} from './js/modules/toolbox-css';

var util = {};
var debug = true;
(function() {
    var os;
    util.getOS = function() {
        if (!os) {
            var clientStrings = [
                {s:'Windows 3.11', r:/Win16/, short:'Win'},
                {s:'Windows 95', r:/(Windows 95|Win95|Windows_95)/, short:'Win'},
                {s:'Windows ME', r:/(Win 9x 4.90|Windows ME)/, short:'Win'},
                {s:'Windows 98', r:/(Windows 98|Win98)/, short:'Win'},
                {s:'Windows CE', r:/Windows CE/, short:'Win'},
                {s:'Windows 2000', r:/(Windows NT 5.0|Windows 2000)/, short:'Win'},
                {s:'Windows XP', r:/(Windows NT 5.1|Windows XP)/, short:'Win'},
                {s:'Windows Server 2003', r:/Windows NT 5.2/, short:'Win'},
                {s:'Windows Vista', r:/Windows NT 6.0/, short:'Win'},
                {s:'Windows 7', r:/(Windows 7|Windows NT 6.1)/, short:'Win'},
                {s:'Windows 8.1', r:/(Windows 8.1|Windows NT 6.3)/, short:'Win'},
                {s:'Windows 8', r:/(Windows 8|Windows NT 6.2)/, short:'Win'},
                {s:'Windows NT 4.0', r:/(Windows NT 4.0|WinNT4.0|WinNT|Windows NT)/, short:'Win'},
                {s:'Windows ME', r:/Windows ME/, short:'Win'},
                //{s:'Android', r:/Android/, short:'Android'},
                {s:'Linux', r:/(Linux|X11)/, short:'Linux'},
                //{s:'iOS', r:/(iPhone|iPad|iPod)/, short:'iOS'},
                {s:'Mac OS X', r:/Mac OS X/, short:'Mac'},
                {s:'Mac OS', r:/(MacPPC|MacIntel|Mac_PowerPC|Macintosh)/, short:'Mac'},
                {s:'UNIX', r:/UNIX/, short:'Unix'},
            ];
            
            for (var id in clientStrings) {
                var cs = clientStrings[id];
                if (cs.r.test(navigator.userAgent)) {
                    os = cs;
                    break;
                }
            }
        }
        
        return os;
    };
})();

ready(function () {

    var reader;
    var parser;
    var file;

    ////////////////////
    // Initialization //
    ////////////////////
    
    // Show any incompatibilities
    var issues = false;
    var msg_array = [];
    
    var msg_error_prefix = '<p>It appears your browser does not support:</p><ul>';
    var msg_error = '';
    if (!window.JSON) {
        msg_error += '<li>JSON API - Used to pass data</li>';
        issues = true;
    }
    if (!window.FileReader) {
        msg_error += '<li>FileReader API - Used to read user files</li>';
        issues = true;
    }
    
    if (!window.Worker) {
        msg_error += '<li>JavaScript Workers - Used to process files</li>';
        issues = true;
    }
    msg_error += '</ul><p>Please upgrade your browser in order to use <strong>.chimera</strong>.</p>';
    if (issues) msg_array.push(msg_error_prefix + msg_error);
    
    if (msg_array.length > 0) console.error(msg_array.join('<hr/>'));
    
    
    ////////////
    // Modals //
    ////////////
    var btnCancelFile = $('#btnFileCancel');
    var elProgressBar = $('#fileProgressBar');
    var divProgress = $('#fileProgressBar div');
    
    $('#filesFile').addEventListener('change', function(event) {
        var files = event.target.files; // FileList object

        if (!files.length) {
            console.warn('Please select a file first!');
            return;
        }
        
        // Show cancel while reading
        addClass(btnCancelFile, 'show');
    
        // Reset for new file
        //closeFile();
        
        file = files[0]; // Read only first file
        var ext = file.name.toLowerCase().slice(-3);
        if (debug) console.log('File: ', file);

        // Determine file type
        switch (ext) {
            case 'jpg' :
            case 'jpeg' :
                parser = 'JPG';
                break;
            case 'swf' :
                parser = 'SWF';
                break;
            default :
                console.error('Invalid file type!');
                return;
        }
        
        // Title before parsing
        //updateSidebar(null, file);
        
        reader = new FileReader();
        reader.onerror = errorHandler;
        reader.onprogress = updateProgress;
        reader.onabort = function () {
            console.info('File read cancelled.');
        };
        reader.onloadstart = function () {
            // Reset progress indicator on new file selection
            divProgress.style.width = '0%';
            divProgress.textContent = '0%';
            addClass(elProgressBar, 'loading');
        };
        reader.onloadend = function () {
            // Ensure that the progress bar displays 100% at the end
            divProgress.style.width = '100%';
            divProgress.textContent = '100%';
            setTimeout(function() {
                removeClass(elProgressBar, 'loading');
                removeClass(btnCancelFile, 'show');
            }, 250);
            //setTimeout(closeModal, 500);
        };
        reader.onload = function (e) {
            createWorker( parser, e.target.result, file, updateDisplay );
        };

        reader.readAsArrayBuffer(file);
    });
    
    btnCancelFile.addEventListener('click', function() {
        if (reader) reader.abort();
    });
    
    function updateProgress(e/*:ProgressEvent*/) {
        if (e.lengthComputable) {
            var percentLoaded = Math.round((e.loaded / e.total) * 100);
            if (percentLoaded < 100) {
                divProgress.style.width = percentLoaded + '%';
                divProgress.textContent = percentLoaded + '%';
            }
        }
    }
    
    function errorHandler(e) {
        var err = e.target.error;
        switch (err.code) {
            case err.NOT_FOUND_ERR:
                console.error('File Not Found!');
                break;
            case err.NOT_READABLE_ERR:
                console.error('File is not readable!');
                break;
            case err.ABORT_ERR:
                break; // noop
            default:
                console.error('An error occurred reading this file.<code>' + err.message + '<br>(' + err.filename + ':' + err.lineno + ')</code>');
        }
    }
    
    function updateDisplay(json, file) {
        alert('done!');
        console.log(json, file);
        
        
    }
    
    function createWorker( parser, buffer, file, onComplete ) {
        var worker = new Worker('js/workers/' + parser + '.js');
        worker.onmessage = function(e) {
            if (e.data.type == 'debug') {
                if (debug) console.info(e.data.message);
                return;
            }
            if (e.data.type == 'warning') {
                if (debug) console.warn(e.data.message);
                return;
            }
            if (e.data.type == 'alert') {
                if (debug) console.warn(e.data.message);
                //Alert.show(e.data.message, Alert.WARNING);
                return;
            }

            //var idx = e.data.fileID;
            var data = e.data.data;
            data.fileSize = file.size;
            data.fileName = file.name;
            if (debug) console.log('Data', data);

            var json = JSON.stringify(data);
            
            onComplete(json, file);
        };

        worker.onerror = function (error) {
            console.error('Worker ' + error.message + '  (' + error.filename + ':' + error.lineno + ')');
            //Alert.show('Error reading file:<code>' + error.message + '<br>(' + error.filename + ':' + error.lineno + ')</code>', Alert.ERROR);
            onComplete({text:'Error reading file', icon:'error'}, file);
        };

        worker.postMessage({
            text: buffer,
            fileID: 0
        });
    }
});