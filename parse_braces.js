const fs = require('fs');
const code = fs.readFileSync('js/cop_map.js', 'utf8');

let stripped = '';
let inStr = false, strCh = '';
for(let i=0; i<code.length; i++) {
  let c = code[i];
  if(!inStr) {
    if(c==='/'&&code[i+1]==='/') { while(code[i]!=='\n'&&i<code.length) i++; continue; }
    if(c==='/'&&code[i+1]==='*') { i+=2; while(!(code[i]==='*'&&code[i+1]==='/')&&i<code.length) i++; i++; continue; }
    if(c==='\''||c==='\"'||c==='\`') { inStr=true; strCh=c; stripped+='S'; continue; }
    stripped += c;
  } else {
    if(c==='\\') { i++; continue; }
    if(c===strCh) { inStr = false; continue; }
    if(strCh==='`' && c==='$' && code[i+1]==='{') {
      stripped += '${'; i++; inStr = false;
    }
  }
}

let b=0;
let lines = stripped.split('\n');
let openLines = [];
for (let i = 0; i < lines.length; i++) {
  for (let c of lines[i]) {
    if (c==='{') { b++; openLines.push(i+1); }
    if (c==='}') { b--; openLines.pop(); }
  }
}
console.log('Unclosed braces opened at lines:', openLines);
