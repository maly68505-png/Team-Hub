/**
 * Exercises the auto-discovery logic (videos folder + timecode script) against
 * a simulated folder tree, with the ExtendScript File/Folder API stubbed.
 */
var fs = require('fs');
var path = require('path');
var AE = path.join(__dirname, '..');

function slice(text, from, to) {
  var a = text.indexOf(from);
  var b = to ? text.indexOf(to) : text.length;
  if (a < 0 || b < 0) { throw new Error('marker not found: ' + (a < 0 ? from : to)); }
  return text.slice(a, b);
}

var core = fs.readFileSync(path.join(AE, 'lib', 'core.jsxinc'), 'utf8');
var auto = fs.readFileSync(path.join(AE, 'lib', 'ui-auto.jsxinc'), 'utf8');

var coreLogic = slice(core, '    function trim(s)', 'AE helpers');
var autoLogic = slice(auto, '    var FOLDER_HINTS', '    function pickComp()');

// ---------------------------------------------------------------- FS stubs

function Folder(p) { this.fsName = p; this.name = p.split('/').pop(); }
function FileStub(p, content) { this.fsName = p; this.name = p.split('/').pop(); this._c = content || ''; }
FileStub.prototype.open = function () { return true; };
FileStub.prototype.read = function () { return this._c; };
FileStub.prototype.close = function () {};

var TREE = {};   // folder path -> array of child Folder/FileStub

function mkFolder(p) { if (!TREE[p]) { TREE[p] = []; } return new Folder(p); }
function addFolder(parent, name) {
  var p = parent + '/' + name;
  mkFolder(p);
  TREE[parent].push(new Folder(p));
  return p;
}
function addFile(parent, name, content) {
  mkFolder(parent);
  TREE[parent].push(new FileStub(parent + '/' + name, content));
}

Object.defineProperty(Folder.prototype, 'exists', { get: function () { return !!TREE[this.fsName]; } });
Object.defineProperty(FileStub.prototype, 'exists', { get: function () { return true; } });
Folder.prototype.getFiles = function () { return TREE[this.fsName] || null; };

// --------------------------------------------------------------- sandbox

var VIDEO_EXT = "mp4,mov,m4v,avi,mkv,mxf,webm,mpg,mpeg,wmv,mts,m2ts,r3d,braw,dv,3gp";
var MIN_MATCH_SCORE = 2, TOL = 0.0005;
var app = { project: { file: null } }, $ = { fileName: '' };

var sb = new Function('VIDEO_EXT', 'MIN_MATCH_SCORE', 'TOL', 'Folder', 'File', 'app', '$',
  coreLogic + '\n' + autoLogic +
  '\nreturn { findVideosFolder: findVideosFolder, findScriptFile: findScriptFile,' +
  ' isHintFolder: isHintFolder, folderHasVideos: folderHasVideos, parseScript: parseScript };'
)(VIDEO_EXT, MIN_MATCH_SCORE, TOL, Folder, FileStub, app, $);

var pass = 0, fail = 0;
function eq(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

var SRT = '1\n00:00:00:00 --> 00:00:05:00\nPERSON_A\n\n2\n00:00:05:00 --> 00:00:12:00\nPERSON_B\n';

// ---------------------------------------------- case 1: the expected layout
console.log('\n-- typical project layout --');
var root = '/Users/me/Project AE';
mkFolder(root);
addFile(root, 'MyProject.aep', '');
addFile(root, 'script.srt', SRT);
var vids = addFolder(root, 'videos');
addFile(vids, 'PERSON_A_take1.mp4', '');
addFile(vids, 'PERSON_B_take3.mp4', '');

var f = sb.findVideosFolder([new Folder(root)]);
eq('finds videos/ folder', f && f.fsName, root + '/videos');
var s = sb.findScriptFile([new Folder(root)], 25);
eq('finds script.srt', s && s.name, 'script.srt');

// ------------------------------------- case 2: nested, oddly named, + noise
console.log('\n-- nested folder, unhelpful names, decoy text files --');
var root2 = '/Users/me/Project2';
mkFolder(root2);
addFile(root2, 'readme.txt', 'this is just notes, no timecodes here at all');
addFile(root2, 'notes.txt', 'call the client back');
var assets = addFolder(root2, 'assets');
var footage = addFolder(assets, 'footage');
addFile(footage, 'sarah_studio.mov', '');
addFile(footage, 'omar_take2.mp4', '');
addFile(assets, 'edit_script.txt', SRT);

var f2 = sb.findVideosFolder([new Folder(root2)]);
eq('finds nested footage/ folder', f2 && f2.fsName, root2 + '/assets/footage');
var s2 = sb.findScriptFile([new Folder(root2)], 25);
eq('picks the real script over decoys', s2 && s2.name, 'edit_script.txt');

// -------------------------------------------- case 3: clips loose in a folder
console.log('\n-- clips sitting loose, no folder named "videos" --');
var root3 = '/Users/me/Project3';
mkFolder(root3);
addFile(root3, 'a.aep', '');
var raw = addFolder(root3, 'raw stuff');
addFile(raw, 'PERSON_A.mp4', '');
addFile(root3, 'tc.srt', SRT);

var f3 = sb.findVideosFolder([new Folder(root3)]);
eq('falls back to any folder with clips', f3 && f3.fsName, root3 + '/raw stuff');

// ------------------------------------------------- case 4: nothing to find
console.log('\n-- empty project folder --');
var root4 = '/Users/me/Empty';
mkFolder(root4);
addFile(root4, 'a.aep', '');
eq('no videos folder -> null', sb.findVideosFolder([new Folder(root4)]), null);
eq('no script -> null', sb.findScriptFile([new Folder(root4)], 25), null);

// ------------------------------------------- case 5: our own log is ignored
console.log('\n-- previous run log must not be mistaken for the script --');
var root5 = '/Users/me/Project5';
mkFolder(root5);
addFile(root5, 'script_replace_log.txt', SRT);   // looks parseable, but is ours
addFile(root5, 'script.srt', SRT);
eq('skips *_replace_log.txt', sb.findScriptFile([new Folder(root5)], 25).name, 'script.srt');

// ------------------------------------------------------------- hint naming
console.log('\n-- folder name hints --');
eq('"videos" is a hint',  sb.isHintFolder(new Folder('/x/videos')), true);
eq('"Footage" is a hint', sb.isHintFolder(new Folder('/x/Footage')), true);
eq('"renders" is not',    sb.isHintFolder(new Folder('/x/renders')), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
