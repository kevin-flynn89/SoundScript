import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

/* Dopo il build, sostituisce il segnaposto __SW_BUILD__ dentro dist/sw.js
   con l'istante del build: così sw.js cambia a ogni deploy e il browser
   rileva subito la nuova versione (toast di aggiornamento). */
function stampServiceWorker() {
  return {
    name: "stamp-service-worker",
    closeBundle() {
      try {
        const file = path.resolve("dist", "sw.js");
        if (!fs.existsSync(file)) return;
        const stamp = new Date().toISOString();
        const code = fs
          .readFileSync(file, "utf8")
          .replace("__SW_BUILD__", stamp);
        fs.writeFileSync(file, code);
      } catch (e) {
        console.warn("Timbro sw.js non applicato:", e);
      }
    }
  };
}

export default defineConfig({
  base: "/SoundScript/",
  define: {
    __APP_VERSION__: JSON.stringify(
      "build " + new Date().toISOString().slice(0, 10).split("-").join(".")
    )
  },
  plugins: [stampServiceWorker()]
});
