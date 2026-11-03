// AdobeReader
// The Adobe Application-Specific JPEG markers in the Supporting the DCT Filters in PostScript Level 2, Technical Note #5116
// http://www.adobe.com/devnet/postscript/pdfs/5116.DCT_Filter.pdf
// http://www.sno.phy.queensu.ca/~phil/exiftool/TagNames/JPEG.html#Adobe
var AdobeReader = (function() {
	return {
		name: 'Adobe EXIF Reader',
		version: '1.0.0',
		
		parse: function( file, o ) {
			var numBytes;
			
			o = o || {};
			o.identifier = file.getASCIIBytes( 4 ); // "Adobe" (zero terminated)
			
			if ( identifier !== "Adobe" ) {
				if (debug) trace( "Not valid Adobe data! " + identifier );
				return false;
			}
			
			// zero termination byte
			file.getByte();
			
			// Two-byte DCTEncode/DCTDecode version number (presently 0x65);
			o.version = file.getUint16();
			
			// Two-byte 
			// 0 bits are benign
			// 1 bits in flags0 pass information that is not essential to decoding
			// 0x8000 bit: Encoder used Blend=1 downsampling
			// Bit 15 = Encoded with Blend=1 downsampling
			o.flags0 = file.getUint16();
			
			// Two-byte
			// 1 bits in flags1 pass information that is essential to decoding
			o.flags1 = file.getUint16();
			
			/*
			0 = Unknown (RGB or CMYK)
			1 = YCbCr
			2 = YCCK
			*/
			o.colorTransform = file.getByte();
			
			switch ( o.colorTransform ) {
				case 0:
					o.colorTransformLabel = "Unknown";
					break;
				case 1:
					o.colorTransformLabel = "YCbCr";
					break;
				case 2:
					o.colorTransformLabel = "YCCK";
					break;
			};
			
			return o;
		}
	};
}());