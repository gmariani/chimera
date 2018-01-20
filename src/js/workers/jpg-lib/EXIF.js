/* global postMessage, trace, debug */

// EXIFReader
// v2.2
// http://www.digitalpreservation.gov/formats/fdd/fdd000146.shtml
// http://web.archive.org/web/20131111073619/http://www.exif.org/Exif2-1.PDF
// http://web.archive.org/web/20130816202844/http://exif.org/Exif2-2.PDF
// Referenced https://github.com/exif-js/exif-js/blob/master/exif.js

var EXIFReader = (function() {
	var bigEnd = false;
	//var debug = true;
	return {
		name: 'EXIF Reader',
		version: '1.0.0',
		
		tiffTags: {
			0x0001 : "InteropIndex", 							// 'R03' = R03 - DCF option file (Adobe RGB) / 'R98' = R98 - DCF basic file (sRGB) / 'THM' = THM - DCF thumbnail file
			0x0002 : "InteropVersion",
			0x000B : "ProcessingSoftware", 						// (used by ACD Systems Digital Imaging)
			0x00FE : /* TIFF */ "NewSubfileType",
			0x00FF : /* TIFF */ "SubfileType",
			0x0100 : /* TIFF */ "ImageWidth", 					
			0x0101 : /* TIFF */ "ImageHeight",
			0x0102 : /* TIFF */ "BitsPerSample", 				// Number of bits per component
			0x0103 : /* TIFF */ "Compression", 					// Compression scheme
			0x0106 : /* TIFF */ "PhotometricInterpretation", 	// Pixel composition
			0x0107 : /* TIFF */ "Thresholding",
			0x0108 : /* TIFF */ "CellWidth",
			0x0109 : /* TIFF */ "CellLength",
			0x010A : /* TIFF */ "FillOrder",
			0x010D : /* TIFF */ "DocumentName",
			0x010E : /* TIFF */ "ImageDescription", 			// Image title
			0x010F : /* TIFF */ "Make", 						// Image input equipment manufacturer
			0x0110 : /* TIFF */ "Model", 						// Image input equipment model
			0x0111 : /* TIFF */ "StripOffsets", 				// Image data location
							//	PreviewImageStart 
							//	JpgFromRawStart 
			0x0112 : /* TIFF */ "Orientation", 					// Orientation of image
			0x0115 : /* TIFF */ "SamplesPerPixel", 				// Number of components
			0x0116 : /* TIFF */ "RowsPerStrip", 				// Number of rows per strip
			0x0117 : /* TIFF */ "StripByteCounts",				// Bytes per compressed strip
							//	PreviewImageLength
							//	JpgFromRawLength
			0x0118 : /* TIFF */ "MinSampleValue",
			0x0119 : /* TIFF */ "MaxSampleValue",
			0x011A : /* TIFF */ "XResolution", 					// Image resolution in width direction
			0x011B : /* TIFF */ "YResolution", 					// Image resolution in height direction
			0x011C : /* TIFF */ "PlanarConfiguration", 			// Image data arrangement
			0x011D : /* TIFF */ "PageName",
			0x011E : /* TIFF */ "XPosition",
			0x011F : /* TIFF */ "YPosition",
			0x0120 : /* TIFF */ "FreeOffsets",
			0x0121 : /* TIFF */ "FreeByteCounts",
			0x0122 : /* TIFF */ "GrayResponseUnit",
			0x0123 : /* TIFF */ "GrayResponseCurve",
			0x0124 : /* TIFF */ "T4Options",
			0x0125 : /* TIFF */ "T6Options",
			0x0128 : /* TIFF */ "ResolutionUnit", // Unit of X and Y resolution
			0x0129 : /* TIFF */ "PageNumber",
			0x012C : "ColorResponseUnit",
			0x012D : /* TIFF */ "TransferFunction", 			// Transfer function
			0x0131 : /* TIFF */ "Software", 					// Software used
			0x0132 : /* TIFF */ "DateTime", 					// File change date and time
			0x013B : /* TIFF */ "Artist", 						// Person who created the image
			0x013C : /* TIFF */ "HostComputer",
			0x013D : /* TIFF */ "Predictor",
			0x013E : /* TIFF */ "WhitePoint", 					// White point chromaticity
			0x013F : /* TIFF */ "PrimaryChromaticities", 		// Chromaticities of primaries
			0x0140 : /* TIFF */ "ColorMap",
			0x0141 : /* TIFF */ "HalftoneHints",
			0x0142 : /* TIFF */ "TileWidth",
			0x0143 : /* TIFF */ "TileLength",
			0x0144 : /* TIFF */ "TileOffsets",
			0x0145 : /* TIFF */ "TileByteCounts",
			0x0146 : "BadFaxLines",
			0x0147 : "CleanFaxData",
			0x0148 : "ConsecutiveBadFaxLines",
			0x014A : "SubIFD ",
			//0x014A : "A100DataOffset", // (the data offset in original Sony DSLR-A100 ARW images)
			0x014C : /* TIFF */ "InkSet",
			0x014D : /* TIFF */ "InkNames",
			0x014E : "NumberofInks",
			0x0150 : /* TIFF */ "DotRange",
			0x0151 : /* TIFF */ "TargetPrinter",
			0x0152 : /* TIFF */ "ExtraSamples",
			0x0153 : /* TIFF */ "SampleFormat",
			0x0154 : /* TIFF */ "SMinSampleValue",
			0x0155 : /* TIFF */ "SMaxSampleValue",
			0x0156 : /* TIFF */ "TransferRange",
			0x0157 : "ClipPath",
			0x0158 : "XClipPathUnits",
			0x0159 : "YClipPathUnits",
			0x015A : "Indexed",
			0x015B : "JPEGTables",
			0x015F : "OPIProxy",
			0x0190 : "GlobalParametersIFD",
			0x0191 : "ProfileType",
			0x0192 : "FaxProfile",
			0x0193 : "CodingMethods",
			0x0194 : "VersionYear",
			0x0195 : "ModeNumber",
			0x01B1 : "Decode",
			0x01B2 : "DefaultImageColor",
			0x01B3 : "T82Options",
			0x01B5 : "JPEGTables",
			0x0200 : /* TIFF */ "JPEGProc",
			0x0201 : /* TIFF */ "JPEGInterchangeFormat", 		// Offset to JPEG SOI
			/* (ThumbnailOffset in IFD1 of JPEG and some TIFF-based images, IFD0 of MRW images and AVI and MOV videos, and the SubIFD in IFD1 of SRW images; PreviewImageStart in MakerNotes and IFD0 of ARW and SR2 images; JpgFromRawStart in SubIFD of NEF images and IFD2 of PEF images; and OtherImageStart in everything else) */
			0x0202 : /* TIFF */ "JPEGInterchangeFormatLength", 	// Bytes of JPEG data
			/* (ThumbnailLength in IFD1 of JPEG and some TIFF-based images, IFD0 of MRW images and AVI and MOV videos, and the SubIFD in IFD1 of SRW images; PreviewImageLength in MakerNotes and IFD0 of ARW and SR2 images; JpgFromRawLength in SubIFD of NEF images, and IFD2 of PEF images; and OtherImageLength in everything else) */
			0x0203 : /* TIFF */ "JPEGRestartInterval",
			0x0205 : /* TIFF */ "JPEGLosslessPredictors",
			0x0206 : /* TIFF */ "JPEGPointTransforms",
			0x0207 : /* TIFF */ "JPEGQTables",
			0x0208 : /* TIFF */ "JPEGDCTables",
			0x0209 : /* TIFF */ "JPEGACTables",
			0x0211 : /* TIFF */ "YCbCrCoefficients", 			// Color space transformation matrix coefficients
			0x0212 : /* TIFF */ "YCbCrSubSampling", 			// Subsampling ratio of Y to C
			0x0213 : /* TIFF */ "YCbCrPositioning", 			// Y and C positioning
			0x0214 : /* TIFF */ "ReferenceBlackWhite", 			// Pair of black and white reference values
			0x022F : "StripRowCounts",
			0x02BC : "ApplicationNotes",
			0x03E7 : "USPTOMiscellaneous",
			0x1000 : "RelatedImageFileFormat",
			0x1001 : "RelatedImageWidth",
			0x1002 : "RelatedImageHeight",
			0x4746 : "Rating",
			0x4747 : "XP_DIP_XML",
			0x4748 : "StitchInfo",
			0x4749 : "RatingPercent",
			0x7000 : "SonyRawFileType",
			0x7032 : "LightFalloffParams",
			0x7035 : "ChromaticAberrationCorrParams",
			0x7037 : "DistortionCorrParams",
			0x800D : "ImageID",
			0x80A3 : "WangTag1",
			0x80A4 : "WangAnnotation",
			0x80A5 : "WangTag3",
			0x80A6 : "WangTag4",
			0x80B9 : "ImageReferencePoints",
			0x80BA : "RegionXformTackPoint",
			0x80BB : "WarpQuadrilateral",
			0x80BC : "AffineTransformMat",
			0x80E3 : "Matteing",
			0x80E4 : "DataType",
			0x80E5 : "ImageDepth",
			0x80E6 : "TileDepth",
			0x8214 : "ImageFullWidth",
			0x8215 : "ImageFullHeight",
			0x8216 : "TextureFormat",
			0x8217 : "WrapModes",
			0x8218 : "FovCot",
			0x8219 : "MatrixWorldToScreen",
			0x821A : "MatrixWorldToCamera",
			0x827D : "Model2",
			0x828D : "CFARepeatPatternDim",
			0x828E : "CFAPattern2",
			0x828F : "BatteryLevel",
			0x8290 : "KodakIFD",
			0x8298 : /* TIFF */ "Copyright",					// Copyright holder
			0x8769 : /* TIFF */ "ExifIFDPointer", 				// A pointer to the Exif IFD
			0x8825 : /* TIFF */ "GPSIFDPointer", 				// A pointer to the GPS Info IFD
			0xA005 : /* TIFF */ "InteroperabilityIFDPointer", 	// InteropOffset A pointer to the Interoperability IFD
			0xC4A5 : "PrintIM",
			0xEA1C : "Padding",
			0xEA1D : "OffsetSchema",
		},
		
		exifTags: {
			/* Tags Relating to Version */
			0x9000 : "ExifVersion",             // EXIF version
			0xA000 : "FlashpixVersion",         // Supported FlashPix version

			/* Tag Relating to Image Data Characteristics */
			0xA001 : "ColorSpace",              // Color space information

			/* Tags Relating to Image Configuration */
			0x9101 : "ComponentsConfiguration", // Meaning of each component
			0x9102 : "CompressedBitsPerPixel",  // Image compression mode
			0xA002 : "PixelXDimension",         // Valid width of meaningful image
			0xA003 : "PixelYDimension",         // Valid height of meaningful image
			
			/* Tags Relating to User Information */
			0x927C : "MakerNote",               // Manufacturer notes
			0x9286 : "UserComment",             // User comments

			/* Tag Relating to Related File Information */
			0xA004 : "RelatedSoundFile",        // Related audio file

			/* Tags Relating to Date and Time */
			0x9003 : "DateTimeOriginal",        // Date and time of original data generation
			0x9004 : "DateTimeDigitized",       // Date and time of digital data generation
			0x9290 : "SubsecTime",              // DateTime sub seconds
			0x9291 : "SubsecTimeOriginal",      // DateTimeOriginal subseconds
			0x9292 : "SubsecTimeDigitized",     // DateTimeDigitized subseconds

			/* Tags Relating to Picture -Taking Conditions */
			0x829A : "ExposureTime",            // Exposure time (in seconds)
			0x829D : "FNumber",                 // F number
			0x8822 : "ExposureProgram",         // Exposure program
			0x8824 : "SpectralSensitivity",     // Spectral sensitivity
			0x8827 : "ISOSpeedRatings",         // ISO speed rating
			0x8828 : "OECF",                    // Optoelectric conversion factor
			0x9201 : "ShutterSpeedValue",       // Shutter speed
			0x9202 : "ApertureValue",           // Lens aperture
			0x9203 : "BrightnessValue",         // Brightness
			0x9204 : "ExposureBiasValue",       // Exposure bias
			0x9205 : "MaxApertureValue",        // Smallest F number of lens
			0x9206 : "SubjectDistance",         // Distance to subject in meters
			0x9207 : "MeteringMode",            // Metering mode
			0x9208 : "LightSource",             // Kind of light source
			0x9209 : "Flash",                   // Flash status
			0x920A : "FocalLength",             // Focal length of the lens in mm
			0x9214 : "SubjectArea",             // Location and area of main subject
			0xA20B : "FlashEnergy",             // Strobe energy in BCPS
			0xA20C : "SpatialFrequencyResponse",    // Spatial frequency response
			0xA20E : "FocalPlaneXResolution",   // Number of pixels in width direction per FocalPlaneResolutionUnit
			0xA20F : "FocalPlaneYResolution",   // Number of pixels in height direction per FocalPlaneResolutionUnit
			0xA210 : "FocalPlaneResolutionUnit",    // Unit for measuring FocalPlaneXResolution and FocalPlaneYResolution
			0xA214 : "SubjectLocation",         // Location of subject in image
			0xA215 : "ExposureIndex",           // Exposure index selected on camera
			0xA217 : "SensingMethod",           // Image sensor type
			0xA300 : "FileSource",              // Image source (3 == DSC)
			0xA301 : "SceneType",               // Scene type (1 == directly photographed)
			0xA302 : "CFAPattern",              // Color filter array geometric pattern
			0xA401 : "CustomRendered",          // Special processing
			0xA402 : "ExposureMode",            // Exposure mode
			0xA403 : "WhiteBalance",            // 1 = auto white balance, 2 = manual
			0xA404 : "DigitalZoomRatio",       // Digital zoom ratio
			0xA405 : "FocalLengthIn35mmFilm",   // Equivalent foacl length assuming 35mm film camera (in mm)
			0xA406 : "SceneCaptureType",        // Type of scene
			0xA407 : "GainControl",             // Degree of overall image gain adjustment
			0xA408 : "Contrast",                // Direction of contrast processing applied by camera
			0xA409 : "Saturation",              // Direction of saturation processing applied by camera
			0xA40A : "Sharpness",               // Direction of sharpness processing applied by camera
			0xA40B : "DeviceSettingDescription",    //
			0xA40C : "SubjectDistanceRange",    // Distance to subject

			/* Other Tags */
			0xA005 : "InteroperabilityIFDPointer", 	// Pointer of Interoperability IFD
			0xA420 : "ImageUniqueID",            	// Identifier assigned uniquely to each image
			0xEA1C : "Padding",
			0xEA1D : "OffsetSchema",
		},
		
		gpsTags: {
			0x0000 : "GPSVersionID", 			// GPS tag version
			0x0001 : "GPSLatitudeRef", 			// North or South Latitude
			0x0002 : "GPSLatitude", 			// Latitude
			0x0003 : "GPSLongitudeRef", 		// East or West Longitude
			0x0004 : "GPSLongitude", 			// Longitude
			0x0005 : "GPSAltitudeRef", 			// Altitude reference
			0x0006 : "GPSAltitude", 			// Altitude
			0x0007 : "GPSTimeStamp", 			// GPS time (atomic clock)
			0x0008 : "GPSSatellites", 			// GPS satellites used for measurement
			0x0009 : "GPSStatus", 				// GPS receiver status
			0x000A : "GPSMeasureMode", 			// GPS measurement mode
			0x000B : "GPSDOP", 					// Measurement precision
			0x000C : "GPSSpeedRef", 			// Speed unit
			0x000D : "GPSSpeed", 				// Speed of GPS receiver
			0x000E : "GPSTrackRef", 			// Reference for direction of movement
			0x000F : "GPSTrack", 				// Direction of movement
			0x0010 : "GPSImgDirectionRef", 		// Reference for direction of image
			0x0011 : "GPSImgDirection", 		// Direction of image
			0x0012 : "GPSMapDatum", 			// Geodetic survey data used
			0x0013 : "GPSDestLatitudeRef", 		// Reference for latitude of destination
			0x0014 : "GPSDestLatitude", 		// Latitude of destination
			0x0015 : "GPSDestLongitudeRef", 	// Reference for longitude of destination
			0x0016 : "GPSDestLongitude", 		// Longitude of destination
			0x0017 : "GPSDestBearingRef", 		// Reference for bearing of destination
			0x0018 : "GPSDestBearing", 			// Bearing of destination
			0x0019 : "GPSDestDistanceRef", 		// Reference for distance to destination
			0x001A : "GPSDestDistance", 		// Distance to destination
			0x001B : "GPSProcessingMethod", 	// Name of GPS processing method
			0x001C : "GPSAreaInformation", 		// Name of GPS area
			0x001D : "GPSDateStamp", 			// GPS date
			0x001E : "GPSDifferential" 			// GPS differential correction
		},
		
		stringValues: {
			/* Tiff Strings */
			InteropIndex: {
				'R03': "R03 - DCF option file (Adobe RGB)",
				'R98': "R98 - DCF basic file (sRGB)",
				'THM': "THM - DCF thumbnail file"
			},
			NewSubfileType: {
				0: "Full-resolution Image",
				1: "Reduced-resolution image",
				2: "Single page of multi-page image",
				3: "Single page of multi-page reduced-resolution image",
				4: "Transparency mask",
				5: "Transparency mask of reduced-resolution image",
				6: "Transparency mask of multi-page image",
				7: "Transparency mask of reduced-resolution multi-page image",
				0x10001: "Alternate reduced-resolution image",
				0xFFFFFFFF: "Invalid"
				/*
				Bit 0 = Reduced resolution
				Bit 1 = Single page
				Bit 2 = Transparency mask
				Bit 3 = TIFF/IT final page
				Bit 4 = TIFF-FX mixed raster content
				*/
			},
			SubfileType: {
				1: "Full-resolution image",
				2: "Reduced-resolution image",
				3: "Single page of multi-page image"
			},
			Compression: {
				1: "Uncompressed",
				2: "CCITT 1D",
				3: "T4/Group 3 Fax",
				4: "T6/Group 4 Fax",
				5: "LZW",
				6: "JPEG (old-style)",
				7: "JPEG",
				8: "Adobe Deflate",
				9: "JBIG B&W",
				10: "JBIG Color",
				99:	"JPEG",
				262: "Kodak 262",
				32766: "Next",
				32767: "Sony ARW Compressed",
				32769: "Packed RAW",
				32770: "Samsung SRW Compressed",
				32771: "CCIRLEW",
				32772: "Samsung SRW Compressed 2",
				32773: "PackBits",
				32809: "Thunderscan",
				32867: "Kodak KDC Compressed",
				32895: "IT8CTPAD",
				32896: "IT8LW",
				32897: "IT8MP",
				32898: "IT8BL",
				32908: "PixarFilm",
				32909: "PixarLog",
				32946: "Deflate",
				32947: "DCS",
				34661: "JBIG",
				34676: "SGILog",
				34677: "SGILog24",
				34712: "JPEG 2000",
				34713: "Nikon NEF Compressed",
				34715: "JBIG2 TIFF FX",
				34718: "Microsoft Document Imaging (MDI) Binary Level Codec",
				34719: "Microsoft Document Imaging (MDI) Progressive Transform Codec",
				34720: "Microsoft Document Imaging (MDI) Vector",
				34892: "Lossy JPEG",
				65000: "Kodak DCR Compressed",
				65535: "Pentax PEF Compressed"
			},
			PhotometricInterpretation: {
				0: "WhiteIsZero",
				1: "BlackIsZero",
				2: "RGB",
				3: "RGB Palette",
				4: "Transparency Mask",
				5: "CMYK",
				6: "YCbCr",
				8: "CIELab",
				9: "ICCLab",
				10: "ITULab",
				32803: "Color Filter Array",
				32844: "Pixar LogL",
				32845: "Pixar LogLuv",
				34892: "Linear Raw"
			},
			Thresholding: {
				1: "No dithering or halftoning",
				2: "Ordered dither or halftone",
				3: "Randomized dither"
			},
			FillOrder: {
				1: "Normal",
				2: "Reversed"
			},
			Orientation: {
				0: "Unknown",
				1: "Horizontal (normal)",
				2: "Mirror horizontal",
				3: "Rotate 180",
				4: "Mirror vertical",
				5: "Mirror horizontal and rotate 270 CW",
				6: "Rotate 90 CW",
				7: "Mirror horizontal and rotate 90 CW",
				8: "Rotate 270 CW"
			},
			PlanarConfiguration: {
				1: "Chunky",
				2: "Planar"
			},
			GrayResponseUnit: {
				1: 0.1,
				2: 0.001,
				3: 0.0001,
				4: 1e-05,
				5: 1e-06
			},
			T4Options: {
				/*
				Bit 0 = 2-Dimensional encoding
				Bit 1 = Uncompressed
				Bit 2 = Fill bits added
				*/
			},
			T6Options: {
				/* Bit 1 = Uncompressed */
			},
			ResolutionUnit: {
				1: "None",
				2: "Inches",
				3: "Centimeters"
			},
			Predictor: {
				1: "None",
				2: "Horizontal differencing"
			},
			CleanFaxData: {
				0: "Clean",
				1: "Regenerated",
				2: "Unclean"
			},
			InkSet: {
				1: "CMYK",
				2: "Not CMYK"
			},
			ExtraSamples: {
				0: "Unspecified",
				1: "Associated Alpha",
				2: "Unassociated Alpha"
			},
			SampleFormat: {
				/*
				(SamplesPerPixel values)
				[Values 0-3]
				*/
				1: "Unsigned",
				2: "Signed",
				3: "Float",
				4: "Undefined",
				5: "Complex int",
				6: "Complex float"
			},
			Indexed: {
				0: "Indexed",
				1: "Not indexed"
			},
			OPIProxy: {
				0: "Higher resolution image does not exist ",
				1: "Higher resolution image exists"
			},
			ProfileType: {
				0: "Unspecified",
				1: "Group 3 FAX"
			},
			FaxProfile: {
				0: "Unknown",
				1: "Minimal B&W lossless, S",
				2: "Extended B&W lossless, F",
				3: "Lossless JBIG B&W, J",
				4: "Lossy color and grayscale, C",
				5: "Lossless color and grayscale, L",
				6: "Mixed raster content, M",
				7: "Profile T",
				255: "Multi Profiles"
			},
			CodingMethods: {
				/*
				Bit 0 = Unspecified compression
				Bit 1 = Modified Huffman
				Bit 2 = Modified Read
				Bit 3 = Modified MR
				Bit 4 = JBIG
				Bit 5 = Baseline JPEG
				Bit 6 = JBIG color
				*/
			},
			JPEGProc: {
				1: "Baseline",
				14: "Lossless"
			},
			YCbCrSubSampling: {
				"1 1": "YCbCr4:4:4 (1 1)",
				"1 2": "YCbCr4:4:0 (1 2)",
				"1 4": "YCbCr4:4:1 (1 4)",
				"2 1": "YCbCr4:2:2 (2 1)",
				"2 2": "YCbCr4:2:0 (2 2)",
				"2 4": "YCbCr4:2:1 (2 4)",
				"4 1": "YCbCr4:1:1 (4 1)",
				"4 2": "YCbCr4:1:0 (4 2)"
			},
			YCbCrPositioning: {
				1: "Centered",
				2: "Co-Sited"
			},
			
			/* Exif Strings */
			ColorSpace: {
				1: "sRGB",
				0xFFFF: "Uncalibrated" // 4095
			},
			ComponentsConfiguration: {
				0: "Does not exist",
				1: "Y",
				2: "Cb",
				3: "Cr",
				4: "R",
				5: "G",
				6: "B",
			},
			ExposureProgram : {
				0 : "Not defined",
				1 : "Manual",
				2 : "Normal program",
				3 : "Aperture priority",
				4 : "Shutter priority",
				5 : "Creative program",
				6 : "Action program",
				7 : "Portrait mode",
				8 : "Landscape mode"
			},
			MeteringMode : {
				0 : "Unknown",
				1 : "Average",
				2 : "CenterWeightedAverage",
				3 : "Spot",
				4 : "MultiSpot",
				5 : "Pattern",
				6 : "Partial",
				255 : "Other"
			},
			LightSource : {
				0 : "Unknown",
				1 : "Daylight",
				2 : "Fluorescent",
				3 : "Tungsten (incandescent light)",
					4 : "Flash",
					9 : "Fine weather",
					10 : "Cloudy weather",
					11 : "Shade",
					12 : "Daylight fluorescent (D 5700 - 7100K)",
					13 : "Day white fluorescent (N 4600 - 5400K)",
					14 : "Cool white fluorescent (W 3900 - 4500K)",
					15 : "White fluorescent (WW 3200 - 3700K)",
				17 : "Standard light A",
				18 : "Standard light B",
				19 : "Standard light C",
				20 : "D55",
				21 : "D65",
				22 : "D75",
					23 : "D50",
					24 : "ISO studio tungsten",
				255 : "Other"
			},
			Flash : {
				0x0000 : "Flash did not fire",
				0x0001 : "Flash fired",
				0x0005 : "Strobe return light not detected",
				0x0007 : "Strobe return light detected",
					0x0009 : "Flash fired, compulsory flash mode",
					0x000D : "Flash fired, compulsory flash mode, return light not detected",
					0x000F : "Flash fired, compulsory flash mode, return light detected",
					0x0010 : "Flash did not fire, compulsory flash mode",
					0x0018 : "Flash did not fire, auto mode",
					0x0019 : "Flash fired, auto mode",
					0x001D : "Flash fired, auto mode, return light not detected",
					0x001F : "Flash fired, auto mode, return light detected",
					0x0020 : "No flash function",
					0x0041 : "Flash fired, red-eye reduction mode",
					0x0045 : "Flash fired, red-eye reduction mode, return light not detected",
					0x0047 : "Flash fired, red-eye reduction mode, return light detected",
					0x0049 : "Flash fired, compulsory flash mode, red-eye reduction mode",
					0x004D : "Flash fired, compulsory flash mode, red-eye reduction mode, return light not detected",
					0x004F : "Flash fired, compulsory flash mode, red-eye reduction mode, return light detected",
					0x0059 : "Flash fired, auto mode, red-eye reduction mode",
					0x005D : "Flash fired, auto mode, return light not detected, red-eye reduction mode",
					0x005F : "Flash fired, auto mode, return light detected, red-eye reduction mode"
			},
			SensingMethod : {
				1 : "Not defined",
				2 : "One-chip color area sensor",
				3 : "Two-chip color area sensor",
				4 : "Three-chip color area sensor",
				5 : "Color sequential area sensor",
				7 : "Trilinear sensor",
				8 : "Color sequential linear sensor"
			},
			SceneCaptureType : {
				0 : "Standard",
				1 : "Landscape",
				2 : "Portrait",
				3 : "Night scene"
			},
			SceneType : {
				1 : "Directly photographed"
			},
			CustomRendered : {
				0 : "Normal process",
				1 : "Custom process"
			},
			WhiteBalance : {
				0 : "Auto white balance",
				1 : "Manual white balance"
			},
			GainControl : {
				0 : "None",
				1 : "Low gain up",
				2 : "High gain up",
				3 : "Low gain down",
				4 : "High gain down"
			},
			Contrast : {
				0 : "Normal",
				1 : "Soft",
				2 : "Hard"
			},
			Saturation : {
				0 : "Normal",
				1 : "Low saturation",
				2 : "High saturation"
			},
			Sharpness : {
				0 : "Normal",
				1 : "Soft",
				2 : "Hard"
			},
			SubjectDistanceRange : {
				0 : "Unknown",
				1 : "Macro",
				2 : "Close view",
				3 : "Distant view"
			},
			FileSource : {
				3 : "DSC"
			},
			
			/* GPS Strings */
			GPSLongitudeRef: {
				E: "East Longitude",
				W: "West Longitude",
			},
			GPSAltitudeRef: {
				0: "Sea level"
			},
			GPSStatus: {
				A: "Measurement in progress",
				V: "Measurement Interoperability",
			},
			GPSMeasureMode: {
				2: "2D Measurement",
				3: "3D Measurement"
			},
			GPSSpeedRef: {
				K: "Kph",
				M: "Mph",
				N: "Knots",
			},
			GPSTrackRef: {
				T: "True direction",
				M: "Magnetic direction",
			},
			GPSImgDirectionRef: {
				T: "True direction",
				M: "Magnetic direction",
			},
			GPSDestLatitudeRef: {
				N: "North latitude",
				S: "South latitude",
			},
			GPSDestLongitudeRef: {
				E: "East longitude",
				W: "West longitude",
			},
			GPSDestBearingRef: {
				T: "True direction",
				M: "Magnetic direction",
			},
			GPSDestDistanceRef: {
				K: "Kph",
				M: "Mph",
				N: "Knots",
			}
		},
		
		parse: function( file, o ) {
			var finalOffset = file.position + o.length - 2,
				tiffOffset = file.position + 6, // After Exif/0/0
				zeroIFDOffset, 
				endianValue, verifyTIFF, exifData, gpsData, tag, 
				identifier = file.getASCIIBytes( 4 ); // "Exif"
			
			if ( identifier !== "Exif" ) {
				if ( debug ) trace( "Not valid EXIF data! " + identifier );
				return false;
			}
			
			// After a 4-byte code, 0x0000 is recorded in 2 bytes. 
			// The reason for recording this code is to avoid duplication with other 
			// applications making use of JPEG application marker segments (APPn).
			file.position++; // null byte
			file.position++; // padding
			
			// Written as either "II" (0x4949) (little endian) or "MM" (0x4D4D)
			// (big endian) depending on the CPU of the machine doing the recording.
			endianValue = file.getUint16();
			if ( endianValue === 0x4949 ) {
				bigEnd = true;
			} else if ( endianValue === 0x4D4D ) {
				bigEnd = false;
			} else {
				if ( debug ) trace( "Not valid TIFF data! (no 0x49 49 or 0x4D 4D)" );
				return false;
			}
			
			// 0x00 2A (fixed)
			verifyTIFF = file.getUint16( bigEnd );
			if ( verifyTIFF !== 0x002A ) {
				if ( debug ) trace( "Not valid TIFF data! (no 0x00 2A)" );
				return false;
			}
			
			// 0th IFD offset. If the TIFF header is followed immediately by
			// the 0th IFD, it is written as 0x00 00 00 08.
			// When the 1st IFD is not recorded, the 0th IFD Offset of Next 
			// IFD terminates with 0x00 00 00 00.
			zeroIFDOffset = file.getUint32( bigEnd ); // After Exif, endian and fixed 42
			if ( zeroIFDOffset < 0x00000008 ) {
				if ( debug ) trace( "Not valid TIFF data! (First offset less than 8)", zeroIFDOffset );
				return false;
			}
			
			o = o || {};
			trace('read tiff');
			o.tags = this.readTags( file, tiffOffset, tiffOffset + zeroIFDOffset, this.tiffTags, bigEnd );
			
			if ( o.tags.ExifIFDPointer ) {
				trace('read exif');
				exifData = this.readTags( file, tiffOffset, tiffOffset + o.tags.ExifIFDPointer, this.exifTags, bigEnd );
				for ( tag in exifData ) {
					/*switch ( tag ) {
						case "LightSource" :
						case "Flash" :
						case "MeteringMode" :
						case "ExposureProgram" :
						case "SensingMethod" :
						case "SceneCaptureType" :
						case "SceneType" :
						case "CustomRendered" :
						case "WhiteBalance" :
						case "GainControl" :
						case "Contrast" :
						case "Saturation" :
						case "Sharpness" :
						case "SubjectDistanceRange" :
						case "FileSource" :
							exifData[tag] = StringValues[tag][exifData[tag]];
							break;

						case "ExifVersion" :
						case "FlashpixVersion" :
							exifData[tag] = String.fromCharCode(exifData[tag][0], exifData[tag][1], exifData[tag][2], exifData[tag][3]);
							break;

						case "ComponentsConfiguration" :
							exifData[tag] =
								StringValues.Components[exifData[tag][0]] +
								StringValues.Components[exifData[tag][1]] +
								StringValues.Components[exifData[tag][2]] +
								StringValues.Components[exifData[tag][3]];
							break;
					}*/
					o.tags[tag] = exifData[tag];
				}
			}

			if ( o.tags.GPSInfoIFDPointer ) {
				trace('read gps');
				gpsData = this.readTags( file, tiffOffset, tiffOffset + o.tags.GPSIFDPointer, this.gpsTags, bigEnd );
				for ( tag in gpsData ) {
					/*switch (tag) {
						case "GPSVersionID" :
							gpsData[tag] = gpsData[tag][0] +
								"." + gpsData[tag][1] +
								"." + gpsData[tag][2] +
								"." + gpsData[tag][3];
							break;
					}*/
					o.tags[tag] = gpsData[tag];
				}
			}
			
			/*for ( tag in o.tags ) {
				if ( o.tags[tag] ) {
					if ( this.stringValues[tag] ) {
						o.tags[tag] = this.stringValues[tag][ o.tags[tag] ];
					}
					
				}
				
			};*/
			
			// Since EXIF reads by offset, adjust position for JPG to continue
			file.position = finalOffset;
			
			return o;
		},
		
		readTags: function( file, tiffOffset, ifdOffset, tagStrings, bigEnd ) {
			trace( "Tags offset: " + ifdOffset );
			var entries = file.getUint16At( ifdOffset, bigEnd ),
				tags = {}, 
				entryOffset, tag, tagID, 
				i;
				
			for ( i = 0; i < entries; i++ ) {
				entryOffset = ifdOffset + 2 + ( i * 12 ); // ifdOffset + ( i * 12 ) + entries;
				tagID = file.getUint16At( entryOffset, bigEnd ); // Bytes 0-1 of IFD
				tag = tagStrings[ tagID ];
				//trace( "Tag: " + tagID.toString(16), 'offset: ' + entryOffset );
				if ( !tag && debug ) {
					trace( "Unknown tag: 0x" + tagID.toString(16).toUpperCase(), 'offset: ' + entryOffset );
					var type = file.getUint16At( entryOffset + 2, bigEnd ),
						numValues = file.getUint32At( entryOffset + 4, bigEnd ),
						typeLabel;
					switch( type ) {
						case 1 : typeLabel = 'BYTE'; break;
						case 2 : typeLabel = 'ASCII'; break;
						case 3 : typeLabel = 'SHORT'; break;
						case 4 : typeLabel = 'LONG'; break;
						case 5 : typeLabel = 'RATIONAL'; break;
						case 6 : typeLabel = 'SBYTE'; break;
						case 7 : typeLabel = 'UNDEFINED'; break;
						case 8 : typeLabel = 'SSHORT'; break;
						case 9 : typeLabel = 'SLONG'; break;
						case 10 : typeLabel = 'SRATIONAL'; break;
						case 11 : typeLabel = 'FLOAT'; break;
						case 12 : typeLabel = 'DOUBLE'; break;
						default : typeLabel = "Unknown";
					}
					trace('type: ' + typeLabel + ', value count: ' + numValues);
					continue;
				}
				
				tags[tag] = this.readTagValue( file, entryOffset, tiffOffset, ifdOffset, bigEnd );
				//trace('vals: ', tags[tag]);
			}
			
			return tags;
		},
		
		readTagValue: function( file, entryOffset, tiffOffset, ifdOffset, bigEnd ) {
			var type = file.getUint16At( entryOffset + 2, bigEnd ), // Bytes 2-3 of IFD
				numValues = file.getUint32At( entryOffset + 4, bigEnd ), // Bytes 4-7 of IFD
				valueOffset = file.getUint32At( entryOffset + 8, bigEnd ) + tiffOffset,
				offset,
				typeLabel,
				vals, val, n, 
				numerator, denominator;

			switch( type ) {
				case 1 : typeLabel = 'BYTE'; break;
				case 2 : typeLabel = 'ASCII'; break;
				case 3 : typeLabel = 'SHORT'; break;
				case 4 : typeLabel = 'LONG'; break;
				case 5 : typeLabel = 'RATIONAL'; break;
				case 6 : typeLabel = 'SBYTE'; break;
				case 7 : typeLabel = 'UNDEFINED'; break;
				case 8 : typeLabel = 'SSHORT'; break;
				case 9 : typeLabel = 'SLONG'; break;
				case 10 : typeLabel = 'SRATIONAL'; break;
				case 11 : typeLabel = 'FLOAT'; break;
				case 12 : typeLabel = 'DOUBLE'; break;
				default : typeLabel = "Unknown";
			}
			//trace('type: ' + typeLabel + ', value count: ' + numValues + ' valueOffset: ' + valueOffset);
			
			switch ( type ) {
				case 1: // BYTE An 8-bit unsigned integer
				case 7: // UNDEFINED An 8-bit byte that can take any value depending on the field definition
					if ( numValues === 1 ) {
						return file.getUint8At( entryOffset + 8, bigEnd );
					} else {
						offset = ( numValues > 4 ) ? valueOffset : ( entryOffset + 8 );
						vals = file.getBytesAt( offset, numValues );
						/*vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getUint8(offset + n);
						}*/
						return vals;
					}
					break;
				case 2: // ASCII An 8-bit byte containing one 7-bit ASCII code. The final byte is terminated with NULL.
					offset = ( numValues > 4 ) ? valueOffset : ( entryOffset + 8 );
					val = file.getASCIIBytesAt( offset, numValues - 1 );
					/*var outstr = "";
					for (n = start; n < start+length; n++) {
						outstr += String.fromCharCode(buffer.getUint8(n));
					}*/
					return val;
				case 3: // SHORT A 16-bit (2-byte) unsigned integer
					if ( numValues === 1 ) {
						vals = file.getUint16At( entryOffset + 8, bigEnd );
						//trace('vals: ', vals);
						return ;
					} else {
						offset = ( numValues > 2 ) ? valueOffset : ( entryOffset + 8 );
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getUint16At( offset + 2 * n, bigEnd );
						}
						//trace('vals: ', vals);
						return vals;
					}
					break;
				case 4: // LONG A 32-bit (4-byte) unsigned integer
					if ( numValues === 1 ) {
						return file.getUint32At( entryOffset + 8, bigEnd );
					} else {
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getUint32At( valueOffset + 4 * 2, bigEnd );
						}
						return vals;
					}
					break;
				case 5: // RATIONAL Two LONGs. The first LONG is the numerator and the second LONG expresses the denominator.
					if ( numValues === 1 ) {
						numerator = file.getUint32At( valueOffset, bigEnd );
						denominator = file.getUint32At( valueOffset + 4, bigEnd );
						val = Number( numerator / denominator );
						val.numerator = numerator;
						val.denominator = denominator;
						return val;
					} else {
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							numerator = file.getUint32At( valueOffset + 8 * n, bigEnd );
							denominator = file.getUint32At( valueOffset + 4 + 8 * n, bigEnd );
							vals[n] = Number( numerator / denominator );
							vals[n].numerator = numerator;
							vals[n].denominator = denominator;
						}
						return vals;
					}
					break;
				case 6: // SBYTE An 8-bit signed (twos-complement) integer
					if ( numValues === 1 ) {
						return file.getInt8At( entryOffset + 8, bigEnd );
					} else {
						offset = ( numValues > 4 ) ? valueOffset : ( entryOffset + 8 );
						//vals = file.getBytesAt( offset, numValues );
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getInt8At( offset + n, bigEnd );
						}
						return vals;
					}
					break;
				case 8: // SSHORT A 16-bit (2-byte) signed (twos-complement) integer.
					if ( numValues === 1 ) {
						//trace('sshort offset: ', entryOffset + 8);
						vals = file.getInt16At( entryOffset + 8, bigEnd );
						//trace('vals: ', vals);
						return;
					} else {
						offset = ( numValues > 2 ) ? valueOffset : ( entryOffset + 8 );
						//trace('sshort offset: ', offset);
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getInt16At( offset + 2 * n, bigEnd );
						}
						//trace('vals: ', vals);
						return vals;
					}
					break;
				case 9: // SLONG A 32-bit (4-byte) signed integer (2's complement notation)
					if ( numValues === 1 ) {
						return file.getInt32At( entryOffset + 8, bigEnd );
					} else {
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getInt32At( valueOffset + 4 * n, bigEnd );
						}
						return vals;
					}
					break;
				case 10: // SRATIONAL Two SLONGs. The first SLONG is the numerator and the second SLONG is the denominator
					if ( numValues === 1 ) {
						return file.getInt32At( valueOffset, bigEnd ) / file.getInt32At( valueOffset + 4, bigEnd);
					} else {
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getInt32At( valueOffset + 8 * n, bigEnd ) / file.getInt32At( valueOffset + 4 + 8 * n, bigEnd );
						}
						return vals;
					}
					break;
				case 11: // FLOAT Single precision (4-byte) IEEE format
					if ( numValues === 1 ) {
						return file.getFloat32At( entryOffset + 8, bigEnd );
					} else {
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getFloat32At( valueOffset + 4 * n, bigEnd );
						}
						return vals;
					}
					break;
				case 12: // DOUBLE Double precision (8-byte) IEEE format
					if ( numValues === 1 ) {
						return file.getFloat64At( entryOffset + 8, bigEnd );
					} else {
						vals = [];
						for ( n = 0; n < numValues; n++ ) {
							vals[n] = file.getFloat64At( valueOffset + 8 * n, bigEnd );
						}
						return vals;
					}
					break;
			}
			
			return vals;
		}
	};
})();