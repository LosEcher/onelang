import { writeFile, readFile, jsonRequest } from "../Utils/NodeUtils";
import { ObjectComparer } from "./ObjectComparer";
import { ExprLangAst as Ast } from "./ExprLangAst";
import { execFileSync } from "child_process";
import { Tokenizer, Token, TokenizerException } from "./Tokenizer";
import { operators, ExpressionParser } from "./ExpressionParser";
import { AstPrinter } from "./AstPrinter";
import { ExprLangVM } from "./ExprLangVM";
const YAML = require('yamljs');

interface TestFile {
    templateTests: { [name: string]: { tmpl: string; model: object; expected: string; }; };
    expressionTests: { [expression: string]: string; };
    expressionAstTests: { [expression: string]: Ast.Expression; };
    vmTests: { [expression: string]: { expected: any; model?: any; }; };
    tokenizerTests: { [expression: string]: { op?: string, i?: string, n?: string, s?: string }[]; };
}

const testFile = <TestFile>YAML.parse(readFile("src/Test/TemplateTest.yaml"));

class TestRunner {
    constructor(public testFile: TestFile) { }

    runTests<T>(tests: { [name: string]: T }, callback: (name: string, test: T) => void) {
        if (!tests) return;

        for (const name of Object.keys(tests)) {
            const test = tests[name];
            try {
                callback(name, test);
            } catch(e) {
                console.log(`${name}: ERROR: ${e}`);
            }
        }
    }

    runTokenizerTests() {
        console.log('============== Tokenizer tests ==============');
        this.runTests(testFile.tokenizerTests, (expr, expectedDesc) => {
            const expected = Array.isArray(expectedDesc) ? expectedDesc.map(x => 
                x.op ? new Token("operator", x.op) :
                x.i ? new Token("identifier", x.i) : 
                x.n ? new Token("number", x.n) :
                x.s ? new Token("string", x.s) :
                "UNKNOWN") : expectedDesc;

            const summary = ObjectComparer.getFullSummary(expected, () => {
                try {
                    return new Tokenizer(expr, operators).tokens;
                } catch(e) {
                    if (e instanceof TokenizerException)
                        return { errorOffset: e.errorOffset, message: e.message };
                    else
                        throw e;
                }
            });

            console.log(`${expr}: ${summary}`);
        });
    }

    runExpressionTests() {
        console.log('============== Expression tests ==============');
        this.runTests(testFile.expressionTests, (expr, expected) => {
            const parsed = new ExpressionParser(expr).parse();
            const repr = AstPrinter.removeOuterParen(AstPrinter.print(parsed));
            if (repr.replace(/\s*/g, "") === expected.replace(/\s*/g, "")) {
                console.log(`${expr}: OK`);
            } else {
                console.log(`${expr}:`);
                console.log(`  expected: ${expected}`);
                console.log(`  got:      ${repr}`);
            }
        });
    }

    runExpressionAstTests() {
        console.log('============== Expression AST tests ==============');
        for (const expr of Object.keys(testFile.expressionAstTests)) {
            const expected = testFile.expressionAstTests[expr];
            const summary = ObjectComparer.getFullSummary(expected,
                () => new ExpressionParser(expr).parse());
            console.log(`${expr}: ${summary}`);
        }
    }

    runVmTests() {
        console.log('============== Expression VM tests ==============');

        const model = {
            sum(a,b) { return a + b; },
            obj: {
                a: 5,
                b: 6,
                method(c) { return this.a + this.b + c; }
            }
        };

        this.runTests(testFile.vmTests, (exprStr, test) => {
            const expr = new ExpressionParser(exprStr).parse();
            const result = ExprLangVM.evaluate(expr, Object.assign({}, model, test.model));
            const ok = result === test.expected;
            console.log(`${exprStr}: ${ok ? "OK" : "FAIL"} (${ok ? result : `got: ${result}, expected: ${test.expected}`})`);
        });
    }
}

//new ExpressionParser("obj.subObj.method").parse();
const testRunner = new TestRunner(testFile);
testRunner.runTokenizerTests();
testRunner.runExpressionAstTests();
testRunner.runExpressionTests();
testRunner.runVmTests();

//for (const testName of Object.keys(testFile.expressionTests)) {
//    const exprTest = testFile.expressionTests[testName];
//    const parsedExpr = parseExpression(exprTest.expr);
//    console.log(`${testName}`, parsedExpr, exprTest.expected);
//}