'use strict';

// web2js's pascal/function-declaration.js, changed so that a procedure's scalar local variables, its
// result and its parameters live in WebAssembly locals and parameters rather than on the shadow
// stack in linear memory, where every read was a load and every write a store, and every argument
// was stored by the caller and loaded again by the callee.
//
// A procedure whose parameters are all scalars or `var` parameters takes them as WebAssembly
// parameters (a `var` parameter as the pointer it always was); one with any other parameter keeps
// web2js's convention, arguments on the shadow stack. A variable whose address is taken (passed as a
// `var` argument, a record or an array, a file) stays in memory: its first `pointer()` or `rebase()`
// throws, and the procedure is generated again with it in memory. The shadow stack frame holds only
// what stays in memory, and a procedure with nothing there touches the stack pointer not at all.
//
// A value is narrowed where it is written, exactly as a store of the variable's width and the
// matching load would narrow it (store8 + load8_u is `& 255`, store8 + load8_s a sign extension from
// bit 7, and so on): a parameter on entry, as the caller's store and the callee's load did, and a
// local on every assignment. So every variable holds the value its memory slot would have held.
//
// What does not change: the static memory layout, globals and string literals, which the core dump
// holds (string literals are allocated as code is generated, so a second attempt at a procedure is
// handed back the strings the first allocated, in order, and a divergence fails the build).

const Binaryen = require('binaryen');
const Environment = require('./environment.js');
const PointerType = require('./pointer-type.js');
const FunctionEvaluation = require('./function-evaluation.js');

let id = 0;

class AddressTaken extends Error {
    constructor(name) {
        super(`the address of ${name} is taken`);
        this.variableName = name;
    }
}

const promotable = (memory, type) => {
    if (type.fileType || type.componentType || type.fields) return false;
    const width = memory.byType(type);
    return [memory.i32, memory.u8, memory.s8, memory.u16, memory.s16, memory.f32].includes(width);
};

const valueTypeOf = (memory, type) => (memory.byType(type) === memory.f32 ? Binaryen.f32 : Binaryen.i32);

const narrowAs = (module, memory, type, e) => {
    const width = memory.byType(type);
    if (width === memory.u8) return module.i32.and(e, module.i32.const(255));
    if (width === memory.u16) return module.i32.and(e, module.i32.const(65535));
    if (width === memory.s8) return module.i32.shr_s(module.i32.shl(e, module.i32.const(24)), module.i32.const(24));
    if (width === memory.s16) return module.i32.shr_s(module.i32.shl(e, module.i32.const(16)), module.i32.const(16));
    if (width === memory.i32 || width === memory.f32) return e;
    throw new Error(`web2js locals: no narrowing for ${type.name}`);
};

const localVariable = (environment, name, type, index) => {
    const module = environment.module;
    const memory = environment.program.memory;
    return {
        name,
        type,
        index,
        promoted: true,
        set(expression) {
            return module.local.set(this.index, narrowAs(module, memory, this.type, expression));
        },
        get() {
            return module.local.get(this.index, valueTypeOf(memory, this.type));
        },
        rebase() {
            throw new AddressTaken(name);
        },
        pointer() {
            throw new AddressTaken(name);
        }
    };
};

/** stack.js's variable, with the frame pointer in local `fp` rather than always in local 0. */
const frameVariable = (environment, name, type, offset, fp, base) => {
    const module = environment.module;
    const memory = environment.program.memory;
    if (base === undefined) base = module.i32.const(0);
    return {
        name,
        offset,
        type,
        base,
        set(expression) {
            return memory
                .byType(this.type)
                .store(this.offset, expression, module.i32.add(module.copyExpression(this.base), module.local.get(fp, Binaryen.i32)));
        },
        get() {
            return memory
                .byType(this.type)
                .load(this.offset, module.i32.add(module.copyExpression(this.base), module.local.get(fp, Binaryen.i32)));
        },
        rebase(type, base) {
            return frameVariable(environment, this.name, type, this.offset, fp, module.i32.add(module.copyExpression(this.base), base));
        },
        pointer() {
            return module.i32.add(module.i32.const(this.offset), module.i32.add(module.copyExpression(this.base), module.local.get(fp, Binaryen.i32)));
        }
    };
};

/**
 * Whether a procedure takes its arguments as WebAssembly parameters: when each is a `var` parameter or
 * a scalar. Decided from the declaration alone, so that a call before the definition agrees with it.
 */
const takesWasmParams = (environment, params) => {
    const memory = environment.program.memory;
    for (const i in params) {
        const param = params[i];
        if (param.reference) continue;
        if (!promotable(memory, environment.resolveType(param.type))) return false;
    }
    return true;
};

module.exports = class FunctionDeclaration {
    constructor(identifier, params, resultType, block) {
        this.identifier = identifier;
        this.params = params;
        this.resultType = resultType;
        this.block = block;
    }

    generate(environment) {
        if (this.block === null) return this.generateWith(environment, new Set());

        const memory = environment.program.memory;
        const made = [];
        let cursor = 0;
        memory.allocateString = function (text) {
            if (cursor < made.length) {
                const m = made[cursor++];
                if (m.text !== text) throw new Error('web2js locals: string allocation diverged between attempts');
                return m.pointer;
            }
            const pointer = Object.getPrototypeOf(this).allocateString.call(this, text);
            made.push({ text, pointer });
            cursor++;
            return pointer;
        };
        const addressTaken = new Set();
        try {
            for (;;) {
                cursor = 0;
                try {
                    return this.generateWith(environment, addressTaken);
                } catch (e) {
                    if (e instanceof AddressTaken && !addressTaken.has(e.variableName)) {
                        addressTaken.add(e.variableName);
                        continue;
                    }
                    throw e;
                }
            }
        } finally {
            delete memory.allocateString;
            if (cursor !== made.length) throw new Error('web2js locals: an attempt allocated fewer strings');
        }
    }

    generateWith(environment, addressTaken) {
        const parentEnvironment = environment;
        environment = new Environment(environment, this.identifier.name);
        const module = environment.module;
        const memory = environment.program.memory;

        const wasmParams = takesWasmParams(environment, this.params);

        parentEnvironment.functions[this.identifier.name] = {
            resultType: this.resultType,
            params: this.params,
            identifier: this.identifier,
            wasmParams,
            evaluate(params) {
                return new FunctionEvaluation(this.identifier, params);
            }
        };

        if (this.block === null) return;

        // WebAssembly's locals: the parameters, when they are WebAssembly's, then the frame pointer,
        // then the result on its way out, then everything promoted.
        const paramTypes = [];
        const paramList = [];
        for (const i in this.params) {
            const param = this.params[i];
            let type = environment.resolveType(param.type);
            if (param.reference) type = new PointerType(type);
            for (const j in param.names) {
                paramList.push({ name: param.names[j].name, type, reference: param.reference });
                if (wasmParams) paramTypes.push(param.reference ? Binaryen.i32 : valueTypeOf(memory, type));
            }
        }

        const fp = paramTypes.length;
        let result = Binaryen.none;
        const localTypes = [Binaryen.i32];
        let resultLocal;
        if (this.resultType) {
            result = environment.resolveType(this.resultType).binaryen();
            resultLocal = fp + localTypes.length;
            localTypes.push(result);
        }
        const newLocal = (valueType) => {
            localTypes.push(valueType);
            return fp + localTypes.length - 1;
        };

        let frame = 0;
        const inFrame = (name, type) => {
            const v = frameVariable(environment, name, type, frame, fp);
            frame += type.bytes();
            return v;
        };

        const addVariable = (name, type) => {
            type = environment.resolveType(type);
            if (!addressTaken.has(name) && promotable(memory, type)) {
                environment.variables[name] = localVariable(environment, name, type, newLocal(valueTypeOf(memory, type)));
            } else environment.variables[name] = inFrame(name, type);
        };

        let resultVariable;
        if (this.resultType) {
            addVariable(this.identifier.name, this.resultType);
            resultVariable = environment.variables[this.identifier.name];
        }

        this.block.vars.forEach((v) => {
            for (const i in v.names) addVariable(v.names[i].name, v.type);
        });

        const prologue = [];
        let popped = 0;

        if (wasmParams) {
            paramList.forEach((param, index) => {
                if (param.reference) {
                    environment.variables[param.name] = memory.dereferencedVariable(
                        param.name,
                        param.type.referent,
                        localVariable(environment, `${param.name} (pointer)`, param.type, index)
                    );
                    return;
                }
                if (addressTaken.has(param.name)) {
                    const v = inFrame(param.name, param.type);
                    prologue.push(v.set(module.local.get(index, valueTypeOf(memory, param.type))));
                    environment.variables[param.name] = v;
                    return;
                }
                const v = localVariable(environment, param.name, param.type, index);
                if (memory.byType(param.type) !== memory.i32 && memory.byType(param.type) !== memory.f32)
                    prologue.push(v.set(v.get()));
                environment.variables[param.name] = v;
            });
        } else {
            // web2js's own convention: the caller pushed the arguments, the first one deepest, and
            // the callee pops them on its way out. They lie just above this procedure's frame, which
            // is complete by now, every local having its place. Each is read once, on entry, into a
            // local unless its address is taken.
            let above = 0;
            for (const param of paramList) above += param.type.bytes();
            popped = above;
            for (const param of paramList) {
                above -= param.type.bytes();
                const slot = frameVariable(environment, param.name, param.type, frame + above, fp);
                let v = slot;
                const holder = param.reference ? `${param.name} (pointer)` : param.name;
                if (!addressTaken.has(holder) && promotable(memory, param.type)) {
                    const l = localVariable(environment, holder, param.type, newLocal(valueTypeOf(memory, param.type)));
                    prologue.push(module.local.set(l.index, slot.get()));
                    v = l;
                }
                environment.variables[param.name] = param.reference
                    ? memory.dereferencedVariable(param.name, param.type.referent, v)
                    : v;
            }
        }

        let code = this.block.generate(environment);

        environment.program.traces[id] = this.identifier.name;

        const stack = environment.program.stack;
        const usesStack = frame > 0 || popped > 0;
        const body = [];
        if (usesStack) {
            body.push(stack.extend(frame));
            body.push(module.local.set(fp, module.global.get('stack', Binaryen.i32)));
        }
        body.push(...prologue, code);
        if (resultVariable) body.push(module.local.set(resultLocal, resultVariable.get()));
        if (usesStack) body.push(stack.shrink(frame + popped));
        if (resultVariable) body.push(module.return(module.local.get(resultLocal, result)));

        module.addFunction(this.identifier.name, Binaryen.createType(paramTypes), result, localTypes, module.block(null, body));

        id = id + 1;

        return;
    }
};
