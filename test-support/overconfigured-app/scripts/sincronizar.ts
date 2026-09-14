// Negative: a Node script, run by the `sincronizar` line in `package.json` and never imported by the
// app. No shebang and no `process.argv`, so no single read of the file places it elsewhere — the
// shape of a real one in the primary fixture that was cited in the default preset.
const respuesta = await fetch('https://api.ejemplo.com/catalogo');
const catalogo: unknown[] = await respuesta.json();
console.log(`${catalogo.length} entradas`);
