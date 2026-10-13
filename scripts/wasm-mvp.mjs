/**
 * Reports everything in a WebAssembly module that is not WebAssembly 1.0, the MVP.
 *
 *   node scripts/wasm-mvp.mjs engine-build/out/tex.wasm.gz
 *
 * The engine has to run in every WebView minAppVersion 1.7.2 admits, iOS 14.5's and Chromium 106's
 * among them, and an engine that uses one instruction such a WebView lacks fails to compile there
 * and nowhere else: every diagram on that device is lost, while the desktop it was built and tested
 * on never shows it. The newer features buy this engine nothing either. With sign extension, bulk
 * memory, SIMD and the rest enabled, binaryen's -O4 emits the same code as without them (binaryen
 * 132, measured 2026-10-12). So the build asks for the MVP, `wasm-opt --mvp-features`, and this
 * reads the result back and refuses anything else.
 *
 * It decodes every section and every instruction rather than searching for byte patterns, because
 * an opcode byte means nothing outside its position: 0xc0 is i32.extend8_s as an instruction and an
 * ordinary byte inside a constant. A module it cannot decode to the end is refused as well, since a
 * decoder that lost its place cannot vouch for anything after that point.
 *
 * Plain JavaScript with no dependencies, so the test suite runs it on the committed engine with no
 * Docker and no binaryen (test/wasm-mvp.test.ts).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** i32, i64, f32, f64. */
const MVP_VALUE_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c]);

/** Value types from later proposals that a module may still declare, by the proposal. */
const LATER_VALUE_TYPES = new Map([
	[0x7b, 'simd'],
	[0x70, 'reference-types'],
	[0x6f, 'reference-types'],
]);

/** The MVP instructions with no immediates, besides the numeric range 0x45–0xbf. */
const NO_IMMEDIATE = new Set([0x00, 0x01, 0x05, 0x0b, 0x0f, 0x1a, 0x1b]);

/** br, br_if, call, local.get/set/tee, global.get/set: one index each. */
const ONE_INDEX = new Set([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24]);

/** Opcodes outside the MVP, by the proposal that added them, so a finding names what to switch off. */
const LATER_OPCODES = new Map([
	...[0x06, 0x07, 0x08, 0x09, 0x0a, 0x18, 0x19, 0x1f].map((op) => [op, 'exception-handling']),
	...[0x12, 0x13].map((op) => [op, 'tail-call']),
	...[0x14, 0x15, 0xd3, 0xd4, 0xd5, 0xd6].map((op) => [op, 'function-references']),
	...[0x1c, 0x25, 0x26, 0xd0, 0xd1, 0xd2].map((op) => [op, 'reference-types']),
	...[0xc0, 0xc1, 0xc2, 0xc3, 0xc4].map((op) => [op, 'sign-ext']),
	[0xfb, 'gc'],
	[0xfd, 'simd'],
	[0xfe, 'threads'],
]);

/** The 0xfc prefix: 0–7 are the saturating float-to-int conversions, 8–17 bulk memory and tables. */
const featureOf0xfc = (sub) =>
	sub <= 7 ? 'nontrapping-float-to-int' : sub <= 17 ? 'bulk-memory' : 'reference-types';

/** Thrown to stop decoding a section or function whose layout depends on something already refused. */
class Abandon extends Error {}

/**
 * @param {Uint8Array} bytes a WebAssembly binary
 * @returns {{ feature: string, where: string }[]} every construct beyond the MVP; empty for an MVP module
 * @throws when the module cannot be decoded at all
 */
export function nonMvpFeatures(bytes) {
	const findings = [];
	let pos = 0;

	const hex = (n) => `0x${n.toString(16)}`;
	const fail = (what) => {
		throw new Error(`${what}, at byte ${hex(pos)}`);
	};
	const found = (feature, what) => findings.push({ feature, where: `${what}, at byte ${hex(pos)}` });
	const refuse = (feature, what) => {
		found(feature, what);
		throw new Abandon();
	};

	const byte = () => {
		if (pos >= bytes.length) fail('unexpected end of module');
		return bytes[pos++];
	};
	/** An unsigned LEB128 of at most 32 bits, as a number. */
	const u32 = () => {
		let result = 0;
		for (let shift = 0; ; shift += 7) {
			if (shift > 28) fail('LEB128 longer than 32 bits');
			const b = byte();
			result += (b & 0x7f) * 2 ** shift;
			if (!(b & 0x80)) return result;
		}
	};
	/** A signed constant, whose value nothing here needs. */
	const skipLeb = (bits) => {
		const most = Math.ceil(bits / 7);
		for (let n = 1; byte() & 0x80; n++) if (n >= most) fail(`LEB128 longer than ${bits} bits`);
	};
	const skip = (n) => {
		if (pos + n > bytes.length) fail('unexpected end of module');
		pos += n;
	};
	const name = () => {
		const length = u32();
		skip(length);
		return new TextDecoder().decode(bytes.subarray(pos - length, pos));
	};

	const valueType = (what) => {
		const t = byte();
		if (MVP_VALUE_TYPES.has(t)) return;
		const feature = LATER_VALUE_TYPES.get(t);
		if (!feature) fail(`unknown value type ${hex(t)} as ${what}`);
		found(feature, `value type ${hex(t)} as ${what}`);
	};
	const limits = (what) => {
		const flags = byte();
		if (flags > 1) found(flags & 4 ? 'memory64' : 'threads', `${what} limits with flags ${hex(flags)}`);
		u32();
		if (flags & 1) u32();
	};
	const tableType = () => {
		const t = byte();
		if (t !== 0x70) found('reference-types', `a table of ${hex(t)}`);
		limits('table');
	};
	const globalType = (what) => {
		valueType(`${what} global`);
		const mutability = byte();
		if (mutability > 1) fail(`global mutability ${hex(mutability)}`);
		return mutability === 1;
	};
	/** The MVP's constant expressions are one constant or one global.get, then end. */
	const constExpr = (what) => {
		const op = byte();
		if (op === 0x41) skipLeb(32);
		else if (op === 0x42) skipLeb(64);
		else if (op === 0x43) skip(4);
		else if (op === 0x44) skip(8);
		else if (op === 0x23) u32();
		else refuse(op === 0xd0 || op === 0xd2 ? 'reference-types' : 'extended-const', `${what} ${hex(op)}`);
		if (byte() !== 0x0b) refuse('extended-const', `${what} of more than one instruction`);
	};

	/** One function body, instruction by instruction, to the end that closes it. */
	const body = (index) => {
		const size = u32();
		const end = pos + size;
		try {
			for (let groups = u32(); groups > 0; groups--) {
				u32();
				valueType(`a local of function ${index}`);
			}
			let depth = 1;
			while (depth > 0) {
				if (pos >= end) fail(`function ${index} runs past its declared size`);
				const op = byte();
				if (op === 0x02 || op === 0x03 || op === 0x04) {
					// block, loop, if: the MVP types one with nothing or a single value type.
					const t = byte();
					if (t !== 0x40 && !MVP_VALUE_TYPES.has(t)) {
						if (LATER_VALUE_TYPES.has(t))
							found(LATER_VALUE_TYPES.get(t), `block of ${hex(t)} in function ${index}`);
						else refuse('multivalue', `block typed by a type index in function ${index}`);
					}
					depth++;
				} else if (op === 0x0b) depth--;
				else if (NO_IMMEDIATE.has(op) || (op >= 0x45 && op <= 0xbf)) continue;
				else if (ONE_INDEX.has(op)) u32();
				else if (op === 0x0e) {
					// br_table: the targets, then the default.
					for (let n = u32(); n >= 0; n--) u32();
				} else if (op === 0x11) {
					u32();
					if (byte() !== 0x00)
						found('reference-types', `call_indirect on another table in function ${index}`);
				} else if (op >= 0x28 && op <= 0x3e) {
					// loads and stores: alignment, offset
					if (u32() & 0x40) found('multi-memory', `a memory index in function ${index}`);
					u32();
				} else if (op === 0x3f || op === 0x40) {
					if (byte() !== 0x00)
						found(
							'multi-memory',
							`memory.size or memory.grow on another memory in function ${index}`,
						);
				} else if (op === 0x41) skipLeb(32);
				else if (op === 0x42) skipLeb(64);
				else if (op === 0x43) skip(4);
				else if (op === 0x44) skip(8);
				else if (op === 0xfc)
					refuse(featureOf0xfc(u32()), `opcode 0xfc ${hex(bytes[pos - 1])} in function ${index}`);
				else if (LATER_OPCODES.has(op))
					refuse(LATER_OPCODES.get(op), `opcode ${hex(op)} in function ${index}`);
				else fail(`unknown opcode ${hex(op)} in function ${index}`);
			}
			if (pos !== end) fail(`function ${index} ends ${end - pos} bytes short of its declared size`);
		} catch (error) {
			// The rest of this function cannot be decoded past what was refused; the next one can.
			if (!(error instanceof Abandon)) throw error;
			pos = end;
		}
	};

	if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)
		fail('not a WebAssembly module');
	const version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
	if (version !== 1) fail(`binary format version ${version}`);
	pos = 8;

	const mutable = [];
	let importedGlobals = 0;
	let importedFunctions = 0;
	while (pos < bytes.length) {
		const id = byte();
		const size = u32();
		const end = pos + size;
		if (end > bytes.length) fail(`section ${id} runs past the end of the module`);
		try {
			switch (id) {
				case 0:
					// Custom sections, names and producers, say nothing about what the engine runs.
					pos = end;
					break;
				case 1:
					for (let n = u32(); n > 0; n--) {
						const form = byte();
						if (form !== 0x60) refuse('gc', `type form ${hex(form)}`);
						for (let p = u32(); p > 0; p--) valueType('a parameter');
						const results = u32();
						if (results > 1) found('multivalue', `a function type with ${results} results`);
						for (let r = results; r > 0; r--) valueType('a result');
					}
					break;
				case 2:
					for (let n = u32(); n > 0; n--) {
						const what = `${name()}.${name()}`;
						const kind = byte();
						if (kind === 0) {
							u32();
							importedFunctions++;
						} else if (kind === 1) tableType();
						else if (kind === 2) limits(`memory ${what}`);
						else if (kind === 3) {
							mutable[importedGlobals++] = globalType(`imported ${what}`);
							if (mutable[importedGlobals - 1])
								found('mutable-globals', `mutable global import ${what}`);
						} else if (kind === 4) refuse('exception-handling', `tag import ${what}`);
						else fail(`unknown import kind ${hex(kind)}`);
					}
					break;
				case 3:
					for (let n = u32(); n > 0; n--) u32();
					break;
				case 4: {
					const tables = u32();
					if (tables > 1) found('reference-types', `${tables} tables`);
					for (let n = tables; n > 0; n--) tableType();
					break;
				}
				case 5: {
					const memories = u32();
					if (memories > 1) found('multi-memory', `${memories} memories`);
					for (let n = memories; n > 0; n--) limits('memory');
					break;
				}
				case 6:
					for (let n = u32(), i = importedGlobals; n > 0; n--, i++) {
						mutable[i] = globalType('a defined');
						constExpr('a global initialiser');
					}
					break;
				case 7:
					for (let n = u32(); n > 0; n--) {
						const exported = name();
						const kind = byte();
						const index = u32();
						if (kind === 3 && mutable[index])
							found('mutable-globals', `mutable global export ${exported}`);
						else if (kind > 3)
							found('exception-handling', `export ${exported} of kind ${hex(kind)}`);
					}
					break;
				case 8:
					u32();
					break;
				case 9:
					for (let n = u32(); n > 0; n--) {
						const flags = u32();
						if (flags !== 0) refuse('bulk-memory', `an element segment with flags ${flags}`);
						constExpr('an element segment offset');
						for (let f = u32(); f > 0; f--) u32();
					}
					break;
				case 10:
					for (let n = u32(), i = importedFunctions; n > 0; n--, i++) body(i);
					break;
				case 11:
					for (let n = u32(); n > 0; n--) {
						const flags = u32();
						if (flags !== 0) refuse('bulk-memory', `a data segment with flags ${flags}`);
						constExpr('a data segment offset');
						skip(u32());
					}
					break;
				case 12:
					refuse('bulk-memory', 'a data count section');
					break;
				case 13:
					refuse('exception-handling', 'a tag section');
					break;
				default:
					fail(`unknown section ${id}`);
			}
		} catch (error) {
			if (!(error instanceof Abandon)) throw error;
			pos = end;
		}
		if (pos !== end) fail(`section ${id} decoded to ${hex(pos)}, declared to end at ${hex(end)}`);
	}
	return findings;
}

// --- command line ---------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const files = process.argv.slice(2);
	if (!files.length) {
		console.error('usage: node scripts/wasm-mvp.mjs <module.wasm | module.wasm.gz> ...');
		process.exit(2);
	}
	let refused = 0;
	for (const file of files) {
		const raw = readFileSync(file);
		const bytes = new Uint8Array(file.endsWith('.gz') ? gunzipSync(raw) : raw);
		let findings;
		try {
			findings = nonMvpFeatures(bytes);
		} catch (error) {
			findings = [
				{ feature: 'undecodable', where: error instanceof Error ? error.message : String(error) },
			];
		}
		if (!findings.length) {
			console.log(`${file}: WebAssembly 1.0 only (${bytes.length} bytes)`);
			continue;
		}
		refused++;
		console.error(`${file}: ${findings.length} construct(s) beyond WebAssembly 1.0`);
		for (const { feature, where } of findings.slice(0, 20))
			console.error(`  ${feature.padEnd(24)} ${where}`);
	}
	process.exit(refused ? 1 : 0);
}
