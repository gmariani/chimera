/*
DefineButton2 extends the capabilities of DefineButton by allowing any state transition to
trigger actions.
The minimum file format version is SWF 3:
Starting with SWF 9, if the ActionScript3 field of the FileAttributes tag is 1, there must be no
BUTTONCONDACTION fields in the DefineButton2 tag. ActionOffset must be 0. This
structure is not supported because it is not permitted to mix ActionScript 1/2 and
ActionScript 3.0 code within the same SWF file.
*/
function DefineButton2(ba, obj) {
	trace('DefineButton2---------');
	this.header = new RecordHeader(ba);
	
	this.id = ba.readUI16();
	ba.readUB(7); // Reserved, always 0
	this.trackAsMenu = ba.readBoolean();
	this.actionOffset = ba.readUI16();
	
	this.characters = [];
	do {
		var record = new ButtonRecord(ba, this.header.type);
		this.characters.push(record);
	} while ((record.buttonStateHitTest || record.buttonStateDown || record.buttonStateOver || record.buttonStateUp));
	this.characters.pop(); // Remove CharacterEndFlag
	
	this.actions = [];
	if (this.actionOffset) {
		var action = new ButtonCondAction(ba);
		while (action.condActionSize) {
			this.actions.push(action);
			action = new ButtonCondAction(ba);
		};
		this.actions.push(action);
	}
	trace('DefineButton2 End---------------------------', this);
};