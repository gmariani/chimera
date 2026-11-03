// JFXXReader
// v1.02
// www.w3.org/Graphics/JPEG/jfif3.pdf
var JFXXReader = (function() {
	return {
		name: 'JFXX Reader',
		version: '1.0.0',
		
		parse: function( file, o ) {
			var i, pixelCount;
			
			o = o || {};
			o.identifier = file.getASCIIBytes( 4 ); // "JFXX" (zero terminated) Id String
			
			if ( identifier !== "JFXX" ) {
				if (debug) trace( "Not valid JFXX data! " + identifier );
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
					};
					
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
					};
					break;
			};
			
			return o;
		}
	};
}());