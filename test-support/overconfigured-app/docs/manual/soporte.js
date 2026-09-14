// GENERATED from manual/src/*.ts — do not edit.
// Negative: a browser bundle kept beside the documentation it drives. It reads `location`, carries no
// client directive, and nothing the app imports reaches it, so it is not on the Next.js server.
"use strict";
(() => {
  function recargar() {
    return fetch(location.href).then((respuesta) => (respuesta.ok ? respuesta.text() : ""));
  }
  window.addEventListener("focus", recargar);
})();
