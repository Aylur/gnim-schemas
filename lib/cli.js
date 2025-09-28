#!/usr/bin/env -S gjs -m
// vim: ft=javascript

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GObject from "gi://GObject"
import System from "system"
import { gettext as t } from "gettext"

const rundir = GLib.get_user_runtime_dir()
const glibCompileSchemas = GLib.find_program_in_path("glib-compile-schemas")
const esbuild = GLib.find_program_in_path("esbuild")
const xmllint = GLib.find_program_in_path("xmllint")

/** @param {string} dir */
function ls(dir) {
  if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
    throw Error(t("not a directory"))
  }

  const enumerator = Gio.File.new_for_path(dir).enumerate_children(
    Gio.FILE_ATTRIBUTE_STANDARD_NAME,
    Gio.FileQueryInfoFlags.NONE,
    null,
  )

  return [...enumerator].flatMap((info) => {
    const file = enumerator.get_child(info)
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null)
    return type === Gio.FileType.DIRECTORY ? [] : [file]
  })
}

/** @param {string} file */
async function getSchemaXml(file) {
  const id = GLib.uuid_string_random()

  const tmpSchemaJs = Gio.File.new_build_filenamev([
    rundir,
    `${id}.js`,
  ]).get_path()

  if (!tmpSchemaJs) {
    throw Error(t("failed to create tmp file"))
  }

  const esbuildProc = Gio.Subprocess.new(
    [
      `${esbuild}`,
      "--bundle",
      file,
      `--outfile=${tmpSchemaJs}`,
      "--external:gi://*",
      "--external:resource://*",
      "--external:system",
      "--external:gettext",
      "--external:console",
      "--format=esm",
      "--sourcemap=inline",
      "--log-level=warning",
    ],
    Gio.SubprocessFlags.STDERR_MERGE,
  )

  if (!esbuildProc.wait(null) || esbuildProc.get_exit_status() !== 0) {
    throw Error(t("esbuild failed"))
  }

  const xmlModule = await import(`file://${tmpSchemaJs}`)
  if (!("default" in xmlModule)) {
    throw Error(t("missing default export in {file}").replace("{file}", file))
  }

  const xml = xmlModule.default
  if (typeof xml !== "string") {
    throw Error(t("typeof default export not a string"))
  }

  Gio.File.new_for_path(tmpSchemaJs).delete(null)
  return xml
}

/** @param {Gio.File} file */
function formatXml(file) {
  if (!xmllint) return

  const path = file.get_path()
  if (!path) throw Error(t("file path is null"))

  const xmllintProc = Gio.Subprocess.new(
    [xmllint, "--format", path],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  )

  const [, out, err] = xmllintProc.communicate_utf8(null, null)

  if (!xmllintProc.get_successful()) {
    throw Error(err.trim())
  }

  const [success] = file.replace_contents(
    new TextEncoder().encode(out.trim()),
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
  )

  if (!success) {
    throw Error(t("xmlint failed"))
  }
}

/**
 * @param {Gio.File} file
 * @param {string} targetdir
 */
async function writeXml(file, targetdir) {
  const name = file.get_basename()
  const path = file.get_path()
  if (!path) throw Error(t("file path is null"))

  if (name?.endsWith(".gschema.ts") || name?.endsWith(".gschema.js")) {
    const xml = await getSchemaXml(path)
    const target = Gio.File.new_build_filenamev([
      targetdir,
      name
        .replace(".gschema.js", ".gschema.xml")
        .replace(".gschema.ts", ".gschema.xml"),
    ])

    const [success] = target.replace_contents(
      new TextEncoder().encode(xml),
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
    )

    if (!success) {
      throw Error(
        t("writing {file} failed").replace(
          "{file}",
          `${target.get_basename()}`,
        ),
      )
    }

    formatXml(target)
  }
}

/** @param {string} dir */
function compileSchemas(dir) {
  if (!glibCompileSchemas) {
    throw Error(t("missing dependency: glib-compile-schemas"))
  }

  const compileProc = Gio.Subprocess.new(
    [glibCompileSchemas, dir],
    Gio.SubprocessFlags.NONE,
  )

  if (!compileProc.wait(null) || compileProc.get_exit_status() !== 0) {
    throw Error(t("glib-compile-schemas failed"))
  }
}

/**
 * @param {string} sourcedir
 * @param {string} targetdir
 */
async function compileXml(sourcedir, targetdir) {
  let count = 0
  if (!esbuild) {
    throw Error(t("missing dependency: esbuild"))
  }

  if (!GLib.file_test(targetdir, GLib.FileTest.IS_DIR)) {
    Gio.File.new_for_path(targetdir).make_directory_with_parents(null)
  }

  for (const file of ls(sourcedir)) {
    await writeXml(file, targetdir)
    count++
  }

  if (count === 0) {
    throw Error(t("no schemas found"))
  }
}

/**
 * @param {string} sourcedir
 * @param {string} targetdir
 * @param {boolean} compile
 */
async function main(sourcedir, targetdir, compile) {
  try {
    await compileXml(sourcedir, targetdir)
    if (compile) {
      compileSchemas(targetdir)
    }
  } catch (error) {
    if (error instanceof Error) {
      printerr(error.message)
    } else {
      logError(error)
    }
    return 1
  }
}

class CLI extends Gio.Application {
  static {
    GObject.registerClass(this)
  }

  constructor() {
    super({
      flags:
        Gio.ApplicationFlags.HANDLES_COMMAND_LINE |
        Gio.ApplicationFlags.NON_UNIQUE,
    })

    GLib.set_prgname("gnim-schemas")

    this.set_option_context_parameter_string(t("DIRECTORY"))
    this.set_option_context_summary(
      t("Compile all GSettings schema files into a schema cache."),
    )

    this.add_main_option(
      "targetdir",
      0,
      GLib.OptionFlags.NONE,
      GLib.OptionArg.STRING,
      t("Where to store the gschemas.compiled file"),
      t("DIRECTORY"),
    )

    this.add_main_option(
      "compile",
      0,
      GLib.OptionFlags.NONE,
      GLib.OptionArg.NONE,
      t("Compile into gschemas.compiled cache"),
      null,
    )
  }

  /** @param {Gio.ApplicationCommandLine} cmd */
  vfunc_command_line(cmd) {
    const [, sourcedir] = cmd.get_arguments()

    const targetdir = /** @type {string} */ (
      cmd
        .get_options_dict()
        .lookup_value("targetdir", GLib.VariantType.new("s"))
        ?.unpack() ?? GLib.get_current_dir()
    )

    const compile = /** @type {boolean} */ (
      cmd
        .get_options_dict()
        .lookup_value("compile", GLib.VariantType.new("b"))
        ?.unpack() ?? false
    )

    if (!sourcedir) {
      printerr(t("source directory argument required"))
      return 1
    }

    this.hold()
    main(sourcedir, targetdir, compile).then((res) => {
      this.release()
      System.exit(res ?? 0)
    })
    return 0
  }
}

void new CLI().runAsync([System.programInvocationName, ...System.programArgs])
