'use strict';

const Binaryen = require('binaryen');
const Identifier = require('./identifier.js');
const PointerType = require('./pointer-type.js');

module.exports = class FunctionEvaluation {
    constructor(f, xs) {
        this.f = f;
        this.xs = xs;
    }

    generate(environment) {
        const module = environment.module;

        const name = this.f.name;

        if (name.toLowerCase() == 'trunc') {
            this.type = new Identifier('integer');
            return module.i32.trunc_s.f32(this.xs[0].generate(environment));
        }

        if (name.toLowerCase() == 'abs') {
            const x = this.xs[0];
            const e = x.generate(environment);

            if (x.type.name == 'real') {
                this.type = new Identifier('real');
                return module.f32.abs(e);
            }

            if (x.type.isInteger()) {
                this.type = new Identifier('integer');
                return module.if(module.i32.ge_s(e, module.i32.const(0)), e, module.i32.mul(e, module.i32.const(-1)));
            }

            throw 'Cannot compute abs.';
        }

        if (name.toLowerCase() == 'round') {
            // nearest is actually "roundeven" which is what round is in pascal
            this.type = new Identifier('integer');
            return module.i32.trunc_s.f32(module.f32.nearest(this.xs[0].generate(environment)));
        }

        if (name.toLowerCase() == 'chr') {
            this.type = new Identifier('char');
            return this.xs[0].generate(environment);
        }

        if (name.toLowerCase() == 'ord') {
            this.type = new Identifier('integer');
            return this.xs[0].generate(environment);
        }

        if (name.toLowerCase() == 'odd') {
            this.type = new Identifier('boolean');
            // https://en.wikipedia.org/wiki/Modulo_operation#Common_pitfalls
            return module.i32.ne(
                module.i32.rem_s(this.xs[0].generate(environment), module.i32.const(2)),
                module.i32.const(0)
            );
        }

        if (name.toLowerCase() == 'erstat') {
            this.type = new Identifier('integer');
            return module.call('erstat', [this.xs[0].generate(environment)], Binaryen.i32);
        }

        if (name.toLowerCase() == 'eoln') {
            this.type = new Identifier('boolean');
            return module.call('eoln', [this.xs[0].generate(environment)], Binaryen.i32);
        }

        if (name.toLowerCase() == 'eof') {
            this.type = new Identifier('boolean');
            return module.call('eof', [this.xs[0].generate(environment)], Binaryen.i32);
        }

        if (name.toLowerCase() == 'inputln_actual') {
            this.type = new Identifier('boolean');

            const file = this.xs[0];
            const bypass_eoln = this.xs[1];
            const buffer = this.xs[2];
            const first = this.xs[3];
            const last = this.xs[4];
            const max_buf_stack = this.xs[5];
            const buf_size = this.xs[6];

            buffer.generate(environment);
            first.generate(environment);
            last.generate(environment);
            max_buf_stack.generate(environment);

            return module.call(
                'inputln',
                [
                    file.generate(environment),
                    bypass_eoln.generate(environment),
                    buffer.variable.pointer(),
                    first.variable.pointer(),
                    last.variable.pointer(),
                    max_buf_stack.variable.pointer(),
                    buf_size.generate(environment)
                ],
                Binaryen.i32
            );
        }

        if (name.toLowerCase() == 'getfilesize') {
            this.type = new Identifier('integer');

            const filename = this.xs[0];
            filename.generate(environment);
            return module.call(
                'getfilesize',
                [module.i32.const(filename.type.index.range()), filename.variable.pointer()],
                Binaryen.i32
            );
        }

        const commands = [];
        const stack = environment.program.stack;

        const theFunction = environment.resolveFunction(this.f);
        if (theFunction === undefined) {
            throw `Could not find function ${this.f.name}`;
            //console.log( `Could not find function ${this.f.name}` );
            //this.type = new Identifier("integer");
            //return module.i32.const(17);
        }

        this.type = theFunction.resultType;

        const params = environment.resolveFunction(this.f).params;
        const byReference = [];
        const types = [];
        for (const i in params) {
            const param = params[i];
            const type = environment.resolveType(param.type);

            // eslint-disable-next-line no-unused-vars
            for (const _j in param.names) {
                byReference.push(param.reference);
                types.push(type);
            }
        }

        // A procedure that takes WebAssembly parameters (function-declaration.js) is handed its
        // arguments as call operands, a `var` argument as its pointer. Each argument is generated
        // twice, as web2js's own convention below does, so that string literals are allocated as
        // they always were.
        const args = [];
        for (const p of this.xs) {
            let exp = p.generate(environment);

            const referenced = byReference.shift();
            let type = environment.resolveType(types.shift());

            if (!type.matches(environment.resolveType(p.type))) {
                throw `Type mismatch for ${type} in call to ${name}`;
            }

            if (referenced) type = new PointerType(type);

            if (theFunction.wasmParams) {
                exp = p.generate(environment);
                // Copied: web2js shares one node among every use of a variable's base, and an operand
                // that the optimiser folds in place, once inlined, would change all of them.
                args.push(module.copyExpression(referenced ? p.variable.pointer() : exp));
                continue;
            }

            commands.push(stack.extend(type.bytes()));
            // How far down the stack went, for a reset of only what a run wrote (memory.js).
            commands.push(environment.program.memory.markStack());

            exp = p.generate(environment);
            let v = undefined;

            if (referenced) {
                v = environment.program.memory.variable(null, type, 0, module.global.get('stack', Binaryen.i32));
                commands.push(v.set(p.variable.pointer()));
            } else {
                v = environment.program.memory.variable(null, type, 0, module.global.get('stack', Binaryen.i32));
                commands.push(v.set(exp));
            }
        }

        if (environment.resolveFunction(this.f) === undefined) {
            throw `Function ${name} is not defined.`;
        }

        let resultType = Binaryen.none;

        if (this.type !== undefined) {
            const t = environment.resolveType(this.type);
            resultType = t.binaryen();

            if (resultType === undefined) {
                throw `Could not identify binaryen type for ${this.type}`;
            }
        }

        commands.push(module.call(name, args, resultType));

        if (this.type !== undefined) return module.block(null, commands, resultType);
        else return module.block(null, commands);
    }
};
