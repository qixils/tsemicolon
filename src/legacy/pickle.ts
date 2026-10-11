/**
 * Just enough of Python's pickle format to read what the old bot stored:
 * numbers, strings, lists, dicts, tuples, references to functions, and
 * simple objects like dataclasses.
 *
 * Nothing is ever executed. A reference to a Python global decodes to a
 * {@link PickleGlobal}, and an object built from one to a
 * {@link PickleObject} holding its constructor arguments and state.
 */
// clod wrote this sorryyy

export class PickleGlobal {
  constructor(readonly module: string, readonly name: string) {}
  get path() { return `${this.module}.${this.name}` }
}

export class PickleObject {
  constructor(readonly type: PickleValue, readonly args: PickleValue[], public state: PickleValue = null) {}
  /** Fully qualified class name, e.g. `cogs.subscriptions.SubscriptionData`. */
  get className() { return this.type instanceof PickleGlobal ? this.type.path : null }
}

export type PickleValue =
  | null | boolean | number | bigint | string | Uint8Array
  | PickleValue[] | PickleDict | PickleGlobal | PickleObject

/** Dicts keep Python's key types, which matters for int-keyed dicts. */
export type PickleDict = Map<PickleValue, PickleValue>

const MARK = Symbol('mark')
type StackItem = PickleValue | typeof MARK

export class UnpicklingError extends Error {}

const decoder = new TextDecoder('utf-8')
const latin1 = new TextDecoder('latin1')

/** Snowflakes don't fit in a double, so big integers stay bigints. */
const narrow = (value: bigint): number | bigint =>
  value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value

/** Two's-complement little-endian integer, as LONG1/LONG4 encode them. */
const decodeLong = (bytes: Uint8Array): number | bigint => {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!)
  if (bytes.length && bytes[bytes.length - 1]! & 0x80) value -= 1n << BigInt(bytes.length * 8)
  return narrow(value)
}

export const unpickle = (data: Uint8Array): PickleValue => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const stack: StackItem[] = []
  const memo = new Map<number, PickleValue>()
  let offset = 0

  const read = (length: number) => {
    if (offset + length > data.length) throw new UnpicklingError('Unexpected end of pickle')
    const bytes = data.subarray(offset, offset + length)
    offset += length
    return bytes
  }
  const u8 = () => read(1)[0]!
  const u16 = () => { const v = view.getUint16(offset, true); offset += 2; return v }
  const u32 = () => { const v = view.getUint32(offset, true); offset += 4; return v }
  const i32 = () => { const v = view.getInt32(offset, true); offset += 4; return v }
  const u64 = () => { const v = Number(view.getBigUint64(offset, true)); offset += 8; return v }
  const line = () => {
    const end = data.indexOf(0x0a, offset)
    if (end < 0) throw new UnpicklingError('Unterminated line')
    const text = latin1.decode(data.subarray(offset, end))
    offset = end + 1
    return text
  }

  const pop = (): PickleValue => {
    const item = stack.pop()
    if (item === undefined || item === MARK) throw new UnpicklingError('Stack underflow')
    return item
  }
  const top = (): PickleValue => {
    const item = stack.at(-1)
    if (item === undefined || item === MARK) throw new UnpicklingError('Stack underflow')
    return item
  }
  /** Everything above the topmost mark, which is removed. */
  const popMark = (): PickleValue[] => {
    const index = stack.lastIndexOf(MARK)
    if (index < 0) throw new UnpicklingError('Missing mark')
    const items = stack.splice(index) as PickleValue[]
    items.shift()
    return items
  }
  const asList = (value: PickleValue) => {
    if (!Array.isArray(value)) throw new UnpicklingError('Expected a list')
    return value
  }
  const asDict = (value: PickleValue) => {
    if (!(value instanceof Map)) throw new UnpicklingError('Expected a dict')
    return value
  }
  const setItems = (dict: PickleDict, items: PickleValue[]) => {
    for (let i = 0; i + 1 < items.length; i += 2) dict.set(items[i]!, items[i + 1]!)
  }
  const build = (type: PickleValue, args: PickleValue[]) => new PickleObject(type, args)

  while (offset < data.length) {
    const opcode = u8()
    switch (opcode) {
      case 0x80: u8(); break // PROTO
      case 0x95: u64(); break // FRAME
      case 0x2e: return pop() // STOP

      case 0x28: stack.push(MARK); break // MARK
      case 0x30: pop(); break // POP
      case 0x31: popMark(); break // POP_MARK
      case 0x32: stack.push(top()); break // DUP

      case 0x4e: stack.push(null); break // NONE
      case 0x88: stack.push(true); break // NEWTRUE
      case 0x89: stack.push(false); break // NEWFALSE
      case 0x4b: stack.push(u8()); break // BININT1
      case 0x4d: stack.push(u16()); break // BININT2
      case 0x4a: stack.push(i32()); break // BININT
      case 0x8a: stack.push(decodeLong(read(u8()))); break // LONG1
      case 0x8b: stack.push(decodeLong(read(u32()))); break // LONG4
      case 0x47: { const v = view.getFloat64(offset, false); offset += 8; stack.push(v); break } // BINFLOAT
      case 0x49: { // INT (protocol 0), where 00/01 meant False/True
        const text = line()
        stack.push(text === '00' ? false : text === '01' ? true : narrow(BigInt(text)))
        break
      }
      case 0x4c: stack.push(narrow(BigInt(line().replace(/L$/, '')))); break // LONG
      case 0x46: stack.push(Number(line())); break // FLOAT

      case 0x8c: stack.push(decoder.decode(read(u8()))); break // SHORT_BINUNICODE
      case 0x58: stack.push(decoder.decode(read(u32()))); break // BINUNICODE
      case 0x8d: stack.push(decoder.decode(read(u64()))); break // BINUNICODE8
      case 0x55: stack.push(latin1.decode(read(u8()))); break // SHORT_BINSTRING
      case 0x54: stack.push(latin1.decode(read(i32()))); break // BINSTRING
      case 0x43: stack.push(read(u8()).slice()); break // SHORT_BINBYTES
      case 0x42: stack.push(read(u32()).slice()); break // BINBYTES
      case 0x8e: stack.push(read(u64()).slice()); break // BINBYTES8

      case 0x5d: stack.push([]); break // EMPTY_LIST
      case 0x29: stack.push([]); break // EMPTY_TUPLE
      case 0x6c: stack.push(popMark()); break // LIST
      case 0x74: stack.push(popMark()); break // TUPLE
      case 0x85: stack.push([pop()]); break // TUPLE1
      case 0x86: { const b = pop(); const a = pop(); stack.push([a, b]); break } // TUPLE2
      case 0x87: { const c = pop(); const b = pop(); const a = pop(); stack.push([a, b, c]); break } // TUPLE3
      case 0x61: { const item = pop(); asList(top()).push(item); break } // APPEND
      case 0x65: { const items = popMark(); asList(top()).push(...items); break } // APPENDS

      case 0x7d: stack.push(new Map()); break // EMPTY_DICT
      case 0x64: { const dict: PickleDict = new Map(); setItems(dict, popMark()); stack.push(dict); break } // DICT
      case 0x73: { const value = pop(); const key = pop(); asDict(top()).set(key, value); break } // SETITEM
      case 0x75: { const items = popMark(); setItems(asDict(top()), items); break } // SETITEMS

      // sets come out as lists; nothing the bot stored relies on set semantics
      case 0x8f: stack.push([]); break // EMPTY_SET
      case 0x90: { const items = popMark(); asList(top()).push(...items); break } // ADDITEMS
      case 0x91: stack.push(popMark()); break // FROZENSET

      case 0x63: { const module = line(); stack.push(new PickleGlobal(module, line())); break } // GLOBAL
      case 0x93: { // STACK_GLOBAL
        const name = pop()
        const module = pop()
        stack.push(new PickleGlobal(String(module), String(name)))
        break
      }
      case 0x52: { const args = pop(); const type = pop(); stack.push(build(type, asList(args))); break } // REDUCE
      case 0x81: { const args = pop(); const type = pop(); stack.push(build(type, asList(args))); break } // NEWOBJ
      case 0x92: { pop(); const args = pop(); const type = pop(); stack.push(build(type, asList(args))); break } // NEWOBJ_EX
      case 0x62: { // BUILD
        const state = pop()
        const target = top()
        if (target instanceof PickleObject) target.state = state
        break
      }

      case 0x94: memo.set(memo.size, top()); break // MEMOIZE
      case 0x71: memo.set(u8(), top()); break // BINPUT
      case 0x72: memo.set(u32(), top()); break // LONG_BINPUT
      case 0x70: memo.set(Number(line()), top()); break // PUT
      case 0x68: stack.push(memo.get(u8()) ?? null); break // BINGET
      case 0x6a: stack.push(memo.get(u32()) ?? null); break // LONG_BINGET
      case 0x67: stack.push(memo.get(Number(line())) ?? null); break // GET

      default:
        throw new UnpicklingError(`Unsupported pickle opcode 0x${opcode.toString(16)} at ${offset - 1}`)
    }
  }
  throw new UnpicklingError('Pickle ended without STOP')
}

/** A snowflake-ish value as a string, or null for anything else. */
export const pickleId = (value: PickleValue | undefined): string | null =>
  typeof value === 'number' || typeof value === 'bigint' ? String(value) : null

/** The attributes of an object built by {@link unpickle}, e.g. a dataclass's fields. */
export const pickleState = (value: PickleValue | undefined): Map<string, PickleValue> => {
  const state = value instanceof PickleObject ? value.state : null
  const result = new Map<string, PickleValue>()
  if (state instanceof Map) for (const [key, item] of state) result.set(String(key), item)
  return result
}
