import { defineConfig } from "vite";

export default defineConfig({
  base: "/SoundScript/",
  define: {
    __APP_VERSION__: JSON.stringify(
      "build " + new Date().toISOString().slice(0, 10).split("-").join(".")
    )
  }
});