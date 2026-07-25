const ms = require('milsymbol');
try {
  const sym = new ms.Symbol('SFGP-------');
  console.log("Success");
} catch(e) {
  console.log("Error:", e);
}
