import { OneAst as ast } from "../../One/Ast";
import { Reader } from "./Reader";
import { NodeManager } from "./NodeManager";

class Operator {
    constructor(public text: string, public precedence: number, public isBinary: boolean, public isRightAssoc: boolean, public isPostfix: boolean) { }
}

export interface ExpressionParserConfig {
    unary: string[];
    precedenceLevels: { name: string, operators?: string[], binary?: boolean }[];
    rightAssoc: string[];
    aliases: { [alias: string]: string };
}

export class ExpressionParser {
    static defaultConfig = <ExpressionParserConfig> {
        unary: ['!', 'not', '+', '-', '~'],
        precedenceLevels: [
            { name: "assignment", operators: ['=', '+=', '-=', '*=', '/=', '<<=', '>>='], binary: true },
            { name: "conditional", operators: ['?'] },
            { name: "or", operators: ['||', 'or'], binary: true },
            { name: "and", operators: ['&&', 'and'], binary: true },
            { name: "comparison", operators: ['>=', '!=', '===', '!==', '==', '<=', '>', '<'], binary: true },
            { name: "sum", operators: ['+','-'], binary: true },
            { name: "product", operators: ['*','/'], binary: true },
            { name: "exponent", operators: ['**'], binary: true },
            { name: "shift", operators: ['<<'], binary: true },
            { name: "range", operators: ['...'], binary: true },
            { name: "prefix" },
            { name: "postfix", operators: ['++', '--'] },
            { name: "call", operators: ['('] },
            { name: "propertyAccess", operators: ['.', '::', '['] },
        ],
        rightAssoc: ['**'],
        aliases: { "===": "==", "!==": "!=", "not": "!", "and": "&&", "or": "||" },
    };

    config: ExpressionParserConfig;
    operatorMap: { [name: string]: Operator };
    operators: string[];
    prefixPrecedence: number;
    literalClassNames: { string: string, numeric: string };

    unaryPrehook: () => ast.Expression = null;

    constructor(public reader: Reader, public nodeManager: NodeManager = null) {
        this.config = JSON.parse(JSON.stringify(ExpressionParser.defaultConfig));
        this.reconfigure();
    }

    reconfigure() {
        this.operatorMap = {};

        for (let i = 0; i < this.config.precedenceLevels.length; i++) {
            const level = this.config.precedenceLevels[i];
            const precedence = i + 1;
            if (level.name === "prefix")
                this.prefixPrecedence = precedence;
            
            if (!level.operators) continue;

            for (const opText of level.operators) {
                const op = new Operator(opText, precedence, level.binary, 
                    this.config.rightAssoc.includes(opText), level.name == "postfix");

                this.operatorMap[opText] = op;
            }
        }

        this.operators = Object.keys(this.operatorMap).sort((a,b) => b.length - a.length);
    }

    parseMapLiteral(keySeparator = ":") {
        if (!this.reader.readToken("{")) return null;

        const mapLiteral = <ast.MapLiteral> { exprKind: "MapLiteral", properties: [] };
        do {
            if (this.reader.peekToken("}")) break;

            const item = <ast.VariableDeclaration> { };
            mapLiteral.properties.push(item);

            item.name = this.reader.readString();
            if (item.name === null)
                item.name = this.reader.expectIdentifier("expected string or identifier as map key");

            this.reader.expectToken(keySeparator);
            item.initializer = this.parse();
        } while(this.reader.readToken(","));

        this.reader.expectToken("}");
        return mapLiteral;
    }

    parseArrayLiteral() {
        if (!this.reader.readToken("[")) return null;
        
        const arrayLiteral = <ast.ArrayLiteral> { exprKind: "ArrayLiteral", items: [] };
        if (!this.reader.readToken("]")) {
            do {
                const item = this.parse();
                arrayLiteral.items.push(item);
            } while(this.reader.readToken(","));

            this.reader.expectToken("]");
        }
        return arrayLiteral;
    }

    parseLeft(): ast.Expression {
        const result = this.unaryPrehook && this.unaryPrehook();
        if (result !== null) return result;

        const unary = this.reader.readAnyOf(this.config.unary);
        if (unary !== null) {
            const right = this.parse(this.prefixPrecedence);
            return <ast.UnaryExpression> { exprKind: "Unary", unaryType: "prefix", operator: unary, operand: right };
        }

        const id = this.reader.readIdentifier();
        if (id !== null)
            return <ast.Identifier> { exprKind: "Identifier", text: id };

        const num = this.reader.readNumber();
        if (num !== null)
            return <ast.Literal> { exprKind: "Literal", literalType: "numeric", value: num, literalClassName: this.literalClassNames.numeric };

        const str = this.reader.readString();
        if (str !== null)
            return <ast.Literal> { exprKind: "Literal", literalType: "string", value: str, literalClassName: this.literalClassNames.string };

        if (this.reader.readToken("(")) {
            const expr = this.parse();
            this.reader.expectToken(")");
            return <ast.ParenthesizedExpression> { exprKind: "Parenthesized", expression: expr };
        }

        this.reader.fail(`unknown (literal / unary) token in expression`);
    }

    parseOperator() {
        let op: Operator = null;
        for (const opText of this.operators)
            if (this.reader.peekToken(opText))
                return this.operatorMap[opText];

        return null;
    }

    parseCallArguments() {
        const args: ast.Expression[] = [];

        if (!this.reader.readToken(")")) {
            do {
                const arg = this.parse();
                args.push(arg);
            } while (this.reader.readToken(","));

            this.reader.expectToken(")");
        }

        return args;
    }

    addNode(node: ast.INode, start: number) {
        if (this.nodeManager !== null)
            this.nodeManager.addNode(node, start);
    }

    parse(precedence = 0): ast.Expression {
        this.reader.skipWhitespace();
        const leftStart = this.reader.offset;
        let left = this.parseLeft();
        this.addNode(left, leftStart);

        while(true) {
            const op = this.parseOperator();
            if (op === null || op.precedence <= precedence) break;
            this.reader.expectToken(op.text);
            const opText = op.text in this.config.aliases ? this.config.aliases[op.text] : op.text;

            if (op.isBinary) {
                const right = this.parse(op.isRightAssoc ? op.precedence - 1 : op.precedence);
                left = <ast.BinaryExpression> { exprKind: "Binary", operator: opText, left, right };
            } else if (op.isPostfix) {
                left = <ast.UnaryExpression> { exprKind: "Unary", unaryType: "postfix", operator: opText, operand: left };
            } else if (op.text === "?") {
                const whenTrue = this.parse();
                this.reader.expectToken(":");
                const whenFalse = this.parse(op.precedence - 1);
                left = <ast.ConditionalExpression> { exprKind: "Conditional", condition: left, whenTrue, whenFalse };
            } else if (op.text === "(") {
                const args = this.parseCallArguments();
                left = <ast.CallExpression> { exprKind: "Call", method: left, arguments: args };
            } else if (op.text === "[") {
                const elementExpr = this.parse();
                this.reader.expectToken("]");
                left = <ast.ElementAccessExpression> { exprKind: "ElementAccess", object: left, elementExpr };
            } else if (op.text === "." || op.text === "::") {
                const prop = this.reader.expectIdentifier("expected identifier as property name");
                left = <ast.PropertyAccessExpression> { exprKind: "PropertyAccess", object: left, propertyName: prop };
            } else {
                this.reader.fail(`parsing '${op.text}' is not yet implemented`);
            }

            this.addNode(left, leftStart);
        }

        return left;
    }
}
