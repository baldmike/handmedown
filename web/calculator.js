// A calculator that lives on the board. Buttons carry data-key; the board
// turns a pinch-tap on one into press(key). No eval: expressions are kept as
// tokens and evaluated with normal precedence (× ÷ before + −).

const KEYS = [
  ["C", "clear"], ["±", "neg"], ["%", "pct"], ["÷", "/"],
  ["7"], ["8"], ["9"], ["×", "*"],
  ["4"], ["5"], ["6"], ["−", "-"],
  ["1"], ["2"], ["3"], ["+", "+"],
  ["0"], ["."], ["⌫", "back"], ["=", "eq"],
];
const SYMBOL = { "+": "+", "-": "−", "*": "×", "/": "÷" };
const MAX_DIGITS = 15;

export const calculatorHtml = `
  <div class="app-head">
    <span class="title">Calculator</span>
    <button class="app-close" data-key="close" tabindex="-1">✕</button>
  </div>
  <div class="calc-screen">
    <div class="calc-expr"></div>
    <div class="calc-value">0</div>
  </div>
  <div class="calc-keys">
    ${KEYS.map(([label, key = label]) => {
      const kind = /^[\d.]$/.test(key) ? "num" : key === "eq" ? "op eq" : "op";
      return `<button class="${kind}" data-key="${key}" tabindex="-1">${label}</button>`;
    }).join("")}
  </div>`;

function format(n) {
  if (!Number.isFinite(n)) return "Error";
  const s = String(parseFloat(n.toPrecision(12)));
  return s.replace("-", "−").length > MAX_DIGITS ? n.toExponential(6) : s;
}

function evaluate(tokens) {
  // First × and ÷, then + and −, left to right.
  const terms = [tokens[0]];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i], n = tokens[i + 1];
    if (op === "*") terms.push(terms.pop() * n);
    else if (op === "/") terms.push(terms.pop() / n);
    else terms.push(op, n);
  }
  let total = terms[0];
  for (let i = 1; i < terms.length; i += 2) total = terms[i] === "+" ? total + terms[i + 1] : total - terms[i + 1];
  return total;
}

export class Calculator {
  constructor(root) {
    this.exprEl = root.querySelector(".calc-expr");
    this.valueEl = root.querySelector(".calc-value");
    this.clear();
  }

  clear() {
    this.tokens = [];      // finished numbers and operators
    this.entry = "0";      // the number being typed
    this.fresh = true;     // next digit starts a new entry
    this.done = false;     // just pressed =
    this.lastExpr = "";
    this.render();
  }

  press(key) {
    if (this.entry === "Error" && key !== "clear") this.clear();
    if (/^\d$/.test(key)) {
      if (this.done) this.tokens = [];
      if (this.fresh || this.entry === "0") this.entry = key;
      else if (this.entry.replace(/[-.]/g, "").length < MAX_DIGITS) this.entry += key;
      this.fresh = this.done = false;
    } else if (key === ".") {
      if (this.done) this.tokens = [];
      if (this.fresh) this.entry = "0.";
      else if (!this.entry.includes(".")) this.entry += ".";
      this.fresh = this.done = false;
    } else if (key in SYMBOL) {
      if (this.done) this.tokens = [];
      if (this.fresh && this.tokens.length) this.tokens[this.tokens.length - 1] = key; // change operator
      else this.tokens.push(Number(this.entry), key);
      this.fresh = true;
      this.done = false;
    } else if (key === "eq") {
      if (!this.tokens.length) return;
      const tokens = [...this.tokens, Number(this.entry)];
      this.lastExpr = this.describe(tokens) + " =";
      this.entry = format(evaluate(tokens)).replace("−", "-");
      this.tokens = [];
      this.fresh = this.done = true;
    } else if (key === "clear") {
      return this.clear();
    } else if (key === "neg") {
      if (this.entry !== "0") this.entry = this.entry.startsWith("-") ? this.entry.slice(1) : "-" + this.entry;
      this.fresh = false;
    } else if (key === "pct") {
      this.entry = format(Number(this.entry) / 100).replace("−", "-");
      this.fresh = false;
    } else if (key === "back") {
      if (this.fresh) return;
      this.entry = this.entry.slice(0, -1);
      if (this.entry === "" || this.entry === "-") this.entry = "0";
    }
    this.render();
  }

  describe(tokens) {
    return tokens.map((t) => (typeof t === "number" ? format(t).replace("-", "−") : SYMBOL[t])).join(" ");
  }

  render() {
    this.exprEl.textContent = this.tokens.length ? this.describe(this.tokens) : this.done ? this.lastExpr : "";
    this.valueEl.textContent = this.entry.replace("-", "−");
  }
}
