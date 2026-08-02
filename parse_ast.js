const fs = require('fs');
const code = fs.readFileSync('js/cop_map.js', 'utf8');

// Strip comments and strings correctly
let stripped = '';
let inStr = false, strCh = '';
for(let i=0; i<code.length; i++) {
  let c = code[i];
  if(!inStr) {
    if(c==='/'&&code[i+1]==='/') { while(code[i]!=='\n'&&i<code.length) i++; stripped+='\n'; continue; }
    if(c==='/'&&code[i+1]==='*') { i+=2; while(!(code[i]==='*'&&code[i+1]==='/')&&i<code.length) { if(code[i]==='\n') stripped+='\n'; i++; } i++; continue; }
    if(c==='\''||c==='\"'||c==='\`') { inStr=true; strCh=c; stripped+='S'; continue; }
    stripped += c;
  } else {
    if(c==='\\') { i++; continue; }
    if(c===strCh) { inStr = false; continue; }
    if(c==='\n') stripped += '\n';
    if(strCh==='`' && c==='$' && code[i+1]==='{') {
      stripped += '${'; i++; inStr = false;
    }
  }
}

let lines = stripped.split('\n');
let openBraces = [];
for (let i = 0; i < lines.length; i++) {
  for (let c of lines[i]) {
    if (c==='{') openBraces.push(i+1);
    if (c==='}') {
       if (openBraces.length > 0) openBraces.pop();
       else console.log("Unmatched } at line", i+1);
    }
  }
}
console.log('Unclosed { opened at lines:', openBraces);
