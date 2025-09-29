# Gnim Schemas

Type-safe Gio Settings schema definitions.

## Demo

1. Define schemas in TypeScript

   ```ts
   // my.app.schema.gschema.ts
   import GLib from "gi://GLib"
   import { defineSchemaList, Schema, Enum, Flags } from "gnim-schemas"

   const myFlags = new Flags("my.flags", ["one", "two"])
   const myEnum = new Enum("my.enum", ["one", "two"])

   export const schema = new Schema({
     id: "my.awesome.app",
     path: "/my/awesome/app/",
   })
     .key("my-key", "s", {
       default: "",
       summary: "Simple string key",
     })
     .key("complex-key", "a{sv}", {
       default: {
         key: GLib.Variant.new("s", "value"),
       },
       summary: "Variant dict key",
     })
     .key("enum-key", myEnum, {
       default: "one",
     })
     .key("flags-key", myFlags, {
       default: ["one", "two"],
     })

   export default defineSchemaList([schema])
   ```

2. Compile the schema

   ```sh
   # works the same way as glib-compile-schemas but for .ts files
   ./node_modules/.bin/gnim-schemas --compile
   ```

3. Infer keys from schema

   ```ts
   // app.ts
   import Gio from "gi://Gio"
   import { schema } from "./my.app.schema.gschema"
   import { createSettings } from "gnim-schemas"

   const gioSettings = new Gio.Settings({ schemaId: schema.id })
   const settings = createSettings(gioSettings, schema)

   settings.myKey.get()
   settings.setMyKey("")
   ```
