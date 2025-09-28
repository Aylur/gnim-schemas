import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { Accessor, type Setter } from "gnim"
import type { DeepInfer, RecursiveInfer } from "./variant"
import { createSettings as _createSettings } from "gnim"

const internal = Symbol("gschema internals")

function serialize(type: string, value: any) {
  return `<![CDATA[ ${GLib.Variant.new(type, value).print(false)} ]]>`
}

function childIf<T>(value: T, child: (value: NonNullable<T>) => XmlNode) {
  return value ? [child(value)] : []
}

type XmlNode = {
  name: string
  attributes?: Record<string, string>
  children?: Array<XmlNode> | string
}

function xml(node: XmlNode | string) {
  if (typeof node === "string") {
    return node
  }
  const { name, attributes, children } = node
  let builder = `<${name}`

  const attrs = Object.entries(attributes ?? [])

  if (attrs.length > 0) {
    for (const [key, value] of attrs) {
      builder += ` ${key}="${value}"`
    }
  }

  if (children && children.length > 0) {
    builder += ">"
    for (const node of children) {
      builder += xml(node)
    }
    builder += `</${name}>`
  } else {
    builder += " />"
  }

  return builder
}

export class Enum<Id extends string, Nick extends string> {
  readonly id: Id
  readonly values: Record<Nick, number>
  declare nicks: Nick

  constructor(id: Id, values: Record<Nick, number> | Nick[]) {
    this.id = id
    this.values = Array.isArray(values)
      ? (Object.fromEntries(
          values.map((nick, index) => [nick, index]),
        ) as Record<Nick, number>)
      : values
  }
}

export class Flags<Id extends string, Nick extends string> {
  readonly id: Id
  readonly values: Record<Nick, number>
  declare nicks: Nick

  constructor(id: Id, values: Record<Nick, number> | Nick[]) {
    this.id = id
    this.values = Array.isArray(values)
      ? (Object.fromEntries(
          values.map((nick, index) => [nick, 2 ** index]),
        ) as Record<Nick, number>)
      : values
  }
}

type TypedKey<Name extends string, Type extends string> = {
  name: Name
  type: Type
}

type EnumKey<Name extends string, Enumeration extends Enum<string, string>> = {
  name: Name
  enum: Enumeration
  aliases: Record<string, Enumeration["nicks"][number]>
}

type FlagsKey<Name extends string, Flag extends Flags<string, string>> = {
  name: Name
  flag: Flag
}

// `override` child nodes are unsupported: use composition instead
// `extends` attribute is unsupported: use composition instead
export class Schema<
  Id extends string,
  TypedKeys extends Array<TypedKey<string, string>> = [],
  EnumKeys extends Array<EnumKey<string, Enum<string, string>>> = [],
  FlagsKeys extends Array<FlagsKey<string, Flags<string, string>>> = [],
> {
  readonly id: Id
  readonly path?: string
  readonly gettextDomain?: string

  constructor(
    props:
      | Id
      | {
          id: Id
          path?: string
          gettextDomain?: string
        },
  ) {
    if (typeof props === "string") {
      this.id = props
    } else {
      this.id = props.id
      this.path = props.path
      this.gettextDomain = props.gettextDomain
    }

    if (props instanceof Schema) {
      this[internal] = {
        typedKeys: new Set(props[internal].typedKeys),
        flagsKeys: new Set(props[internal].flagsKeys),
        enumKeys: new Set(props[internal].enumKeys),
        nodes: [...props[internal].nodes],
      }
    }
  }

  [internal] = {
    typedKeys: new Set<TypedKey<string, string>>(),
    flagsKeys: new Set<FlagsKey<string, Flags<string, string>>>(),
    enumKeys: new Set<EnumKey<string, Enum<string, string>>>(),
    nodes: new Array<XmlNode>(),
  }

  #addFlagsKey(key: FlagsKey<string, Flags<string, string>>) {
    const schema = new Schema<Id, TypedKeys, EnumKeys, FlagsKeys>(this)
    schema[internal].flagsKeys.add(key)
    return schema
  }

  #addEnumKey(key: EnumKey<string, Enum<string, string>>) {
    const schema = new Schema<Id, TypedKeys, EnumKeys, FlagsKeys>(this)
    schema[internal].enumKeys.add(key)
    return schema
  }

  #addTypedKey(key: TypedKey<string, string>) {
    const schema = new Schema<Id, TypedKeys, EnumKeys, FlagsKeys>(this)
    schema[internal].typedKeys.add(key)
    return schema
  }

  #addKey(
    name: string,
    type: { type: string } | { enum: string } | { flags: string },
    children: Array<XmlNode>,
  ) {
    if (this[internal].nodes.some((key) => key.attributes?.name === name)) {
      throw Error(`duplicate key: "${name}"`)
    }

    const schema = new Schema<Id, TypedKeys, EnumKeys, FlagsKeys>(this)
    schema[internal].nodes.push({
      name: "key",
      attributes: Object.assign({ name }, type),
      children,
    })
    return schema
  }

  // `range` child nodes are not yet supported
  // `choices` child nodes are not supported: use enum/flags instead
  key<const Name extends string, const Type extends string>(
    name: Name,
    type: Type,
    props: {
      default: DeepInfer<Type>
      summary?: string
      description?: string
    },
  ) {
    return this.#addTypedKey({ name, type }).#addKey(name, { type }, [
      { name: "default", children: serialize(type, props.default) },
      ...childIf(props.summary, (summary) => ({
        name: "summary",
        children: summary,
      })),
      ...childIf(props.description, (description) => ({
        name: "description",
        children: description,
      })),
    ]) as Schema<
      Id,
      [...TypedKeys, { name: Name; type: Type }],
      EnumKeys,
      FlagsKeys
    >
  }

  // `aliases` not yet supported
  enum<const Name extends string, E extends Enum<string, string>>(
    name: Name,
    enumeration: E,
    props: {
      default: E["nicks"]
      summary?: string
      description?: string
    },
  ) {
    return this.#addEnumKey({ name, enum: enumeration, aliases: {} }).#addKey(
      name,
      { enum: enumeration.id },
      [
        { name: "default", children: serialize("s", props.default) },
        ...childIf(props.summary, (summary) => ({
          name: "summary",
          children: summary,
        })),
        ...childIf(props.description, (description) => ({
          name: "description",
          children: description,
        })),
      ],
    ) as Schema<Id, TypedKeys, [...EnumKeys, EnumKey<Name, E>], FlagsKeys>
  }

  flags<const Name extends string, F extends Flags<string, string>>(
    name: Name,
    enumeration: F,
    props: {
      default: Array<F["nicks"]>
      summary?: string
      description?: string
    },
  ) {
    return this.#addFlagsKey({ name, flag: enumeration }).#addKey(
      name,
      { flags: enumeration.id },
      [
        { name: "default", children: serialize("as", props.default) },
        ...childIf(props.summary, (summary) => ({
          name: "summary",
          children: summary,
        })),
        ...childIf(props.description, (description) => ({
          name: "description",
          children: description,
        })),
      ],
    ) as Schema<Id, TypedKeys, EnumKeys, [...FlagsKeys, FlagsKey<Name, F>]>
  }

  // TODO: support children nodes
  // child<const Name extends string>(name: Name, schema: Schema) {
  // }
}

export function defineSchemaList(
  props:
    | Array<Schema<any, any, any, any>>
    | { gettextDomain: string; schemas: Array<Schema<any, any, any, any>> },
) {
  const schemas = Array.isArray(props) ? props : props.schemas
  const enums = new Set(
    schemas.flatMap((s) =>
      [...s[internal].enumKeys.values()].map((e) => e.enum),
    ),
  )
  const flags = new Set(
    schemas.flatMap((s) =>
      [...s[internal].flagsKeys.values()].map((f) => f.flag),
    ),
  )

  return xml({
    name: "schemalist",
    attributes:
      "gettextDomain" in props ? { gettextDomain: props.gettextDomain } : {},
    children: [
      ...[...enums.values()].map(({ id, values }) => ({
        name: "enum",
        attributes: { id },
        children: Object.entries(values).map(([nick, value]) => ({
          name: "value",
          attributes: { nick, value: value.toString() },
        })),
      })),

      ...[...flags.values()].map(({ id, values }) => ({
        name: "flags",
        attributes: { id },
        children: Object.entries(values).map(([nick, value]) => ({
          name: "value",
          attributes: { nick, value: value.toString() },
        })),
      })),

      ...schemas.map((s) => ({
        name: "schema",
        attributes: {
          id: s.id,
          ...(s.path && { path: s.path }),
          ...(s.gettextDomain && { gettextDomain: s.gettextDomain }),
        },
        children: s[internal].nodes,
      })),
    ],
  })
}

type Pascalify<S> = S extends `${infer Head}${"-" | "_"}${infer Tail}`
  ? `${Capitalize<Head>}${Pascalify<Tail>}`
  : S extends string
    ? Capitalize<S>
    : never

type CamelCase<S extends string> = Uncapitalize<Pascalify<S>>

type Settings<S> =
  S extends Schema<any, infer TypedKeys, infer EnumKeys, infer FlagsKeys>
    ? {
        [K in TypedKeys[number] as CamelCase<K["name"]>]: Accessor<
          RecursiveInfer<K["type"]>
        >
      } & {
        [K in TypedKeys[number] as `set${Pascalify<K["name"]>}`]: Setter<
          DeepInfer<K["type"]>
        >
      } & {
        [E in EnumKeys[number] as CamelCase<E["name"]>]: Accessor<
          E["enum"]["nicks"]
        >
      } & {
        [E in EnumKeys[number] as `set${Pascalify<E["name"]>}`]: Setter<
          E["enum"]["nicks"]
        >
      } & {
        [F in FlagsKeys[number] as CamelCase<F["name"]>]: Accessor<
          Array<F["flag"]["nicks"]>
        >
      } & {
        [F in FlagsKeys[number] as `set${Pascalify<F["name"]>}`]: Setter<
          Array<F["flag"]["nicks"]>
        >
      }
    : never

export type Prettify<T> = { [K in keyof T]: T[K] } & {}

export function createSettings<S extends Schema<any, any, any, any>>(
  settings: Gio.Settings,
  schema: S,
): Prettify<Settings<S>> {
  const keys = [
    ...[...schema[internal].typedKeys].map((key) => [key.name, key.type]),
    ...[...schema[internal].enumKeys].map((key) => [key.name, "s"]),
    ...[...schema[internal].flagsKeys].map((key) => [key.name, "as"]),
  ]

  return _createSettings(settings, Object.fromEntries(keys)) as Settings<S>
}
