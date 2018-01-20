/* global debug, trace, ArrayBuffer, DataView, Int8Array, postMessage, error, JPEGReader */

// JFIFReader
// v1.02
// www.w3.org/Graphics/JPEG/jfif3.pdf
var JFIFReader = (function() {
	return {
		name: 'JFIF Reader',
		version: '1.0.0',
		
		parse: function( file, o ) {
			var numBytes;
			
			o = o || {};
			o.identifier = file.getASCIIBytes( 4 ); // "JFIF" (zero terminated)
			
			if ( o.identifier !== "JFIF" ) {
				if (debug) trace( "Not valid JFIF data! " + o.identifier );
				return false;
			}
			
			// zero byte
			file.getByte();
			
			o.version = { major: file.getUint8(), minor: file.getUint8() };
			o.units = file.getUint8(); // Units used for Resolution
			
			switch( o.units ) {
				case 0:
					// x/y-density specify the aspect ratio instead
					o.unitsLabel = "Aspect Ratio";
					break;
				case 1:
					// x/y-density are dots/inch
					o.unitsLabel = "DPI";
					break;
				case 2:
					// x/y-density are dots/cm
					o.unitsLabel = "DPCM";
					break;
			}
			
			o.xDensity = file.getUint16(); // Horizontal Resolution
			o.yDensity = file.getUint16(); // Vertical Resolution
			o.thumbWidth = file.getUint8();
			o.thumbHeight = file.getUint8();
			
			// n bytes For thumbnail (RGB 24 bit), 
			// n = width*height*3 bytes should be read immediately followed by thumbnail height
			numBytes = o.thumbWidth * o.thumbHeight * 3;
			o.thumbData = ( numBytes > 0 ) ? file.getBytes( numBytes ) : null;
			
			return o;
		},
		
		parseExtension: function( file, o ) {
			var i, pixelCount;
			
			o = o || {};
			o.identifier = file.getASCIIBytes( 4 ); // "JFXX" (zero terminated) Id String
			
			if ( o.identifier !== "JFXX" ) {
				if (debug) trace( "Not valid JFXX data! " + o.identifier );
				return false;
			}
			
			// zero byte
			file.getByte();
			
			o.extensionCode = file.getUint8(); // Extension ID Code
			
			switch( o.units ) {
				case 0x10:
					o.extensionCodeLabel = "Thumbnail coded using JPEG";
					o.extensionData = JPEGReader.parse( file );
					break;
				case 0x11:
					o.extensionCodeLabel = "Thumbnail stored using 1 byte/pixel";
					o.extensionData = {};
					o.extensionData.thumbWidth = file.getUint8();
					o.extensionData.thumbHeight = file.getUint8();
					
					o.extensionData.palette = [];
					for ( i = 0; i < 256; i++ ) {
						o.extensionData.palette.push( file.getBytes(3) ); // RGB
					}
					
					o.extensionData.pixels = file.getBytes( o.extensionData.thumbWidth * o.extensionData.thumbHeight );
					break;
				case 0x13:
					o.extensionCodeLabel = "Thumbnail stored using 3 bytes/pixel";
					o.extensionData = {};
					o.extensionData.thumbWidth = file.getUint8();
					o.extensionData.thumbHeight = file.getUint8();
					
					pixelCount = o.extensionData.thumbWidth * o.extensionData.thumbHeight;
					o.extensionData.pixels = [];
					for ( i = 0; i < pixelCount; i++ ) {
						o.extensionData.pixels.push( file.getBytes(3) ); // RGB
					}
					break;
			}
			
			return o;
		}
	};
}());