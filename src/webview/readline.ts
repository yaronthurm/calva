import { LineInputModel, ModelEdit, EditableDocument, ModelEditSelection } from "../cursor-doc/model";
import { Token, validPair } from "../cursor-doc/clojure-lexer";
import { TokenCursor, LispTokenCursor } from "../cursor-doc/token-cursor";

/** A cheesy utility canvas, used to measure the length of text. */
const canvas = document.createElement("canvas");
let ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

/** Returns the length of the string. */
function measureText(str: string) {
    return ctx.measureText(str).width;
}

export type CompletionEvent = ClearCompletion | ShowCompletion;

interface ClearCompletion {
    type: "clear";
}

interface ShowCompletion {
    type: "show"
    position: number;
    toplevel: string;
}

export type CompletionListener = (c: CompletionEvent) => void;

/**
 * A syntax-highlighting text editor.
 */
export class ReplReadline implements EditableDocument {
    /** Event listeners for completion */
    private _completionListeners: CompletionListener[] = [];

    addCompletionListener(c: CompletionListener) {
        if (this._completionListeners.indexOf(c) == -1)
            this._completionListeners.push(c);
    }

    removeCompletionListener(c: CompletionListener) {
        let idx = this._completionListeners.indexOf(c);
        if (idx != -1)
            this._completionListeners.splice(idx, 1);
    }

    /** The offset of the start of the selection into the document. */
    //private _selectionStart: number = 0;

    private _selection = new ModelEditSelection(0);

    /** Returns the offset of the start of the selection. */
    get selectionLeft() {
        return this._selection.anchor;
    };

    // /** Sets the start of the selection. */
    set selectionLeft(val: number) {
        this._selection.anchor = Math.min(this.model.maxOffset, Math.max(val, 0));
    }

    set selection(selection: ModelEditSelection) {
        this._selection = selection;
    }

    get selection(): ModelEditSelection {
        return new ModelEditSelection(this.selectionLeft, this.selectionRight);
    }

    /** The offset of the end of the selection into the document. */
    //private _selectionEnd: number = 0;

    /** Returns the offset of the end of the selection. */
    get selectionRight() {
        return this._selection.active;
    };

    /** Sets the end of the selection. */
    set selectionRight(val: number) {
        this._selection.active = Math.min(this.model.maxOffset, Math.max(val, 0));
    }

    /** The underlying tokenized source. */
    model = new LineInputModel(1, this);

    /** The HTMLDivElements in the rendered view for each line. */
    inputLines: HTMLDivElement[] = [];

    /** The element representing the caret. */
    caret: HTMLDivElement;

    /** The target column of the caret, for up/down movement. */
    caretX: number = 0;

    /** The start of the selection when we last updated the component's DOM. */
    private lastSelectionStart: number = 0;

    /** The end of the selection when we last updated the component's DOM. */
    private lastSelectionEnd: number = 0;

    /**
     * Returns a TokenCursor into the document.
     *
     * @param row the line to position the cursor at.
     * @param col the column to position the cursor at.
     * @param previous if true, position the cursor at the previous token.
     */
    public getTokenCursor(offset: number = this.selectionRight, previous: boolean = false) {
        let [row, col] = this.model.getRowCol(offset);
        let line = this.model.lines[row]
        let lastIndex = 0;
        if (line) {
            for (let i = 0; i < line.tokens.length; i++) {
                let tk = line.tokens[i];
                if (previous ? tk.offset > col : tk.offset > col)
                    return new LispTokenCursor(this.model, row, previous ? Math.max(0, lastIndex - 1) : lastIndex);
                lastIndex = i;
            }
            return new LispTokenCursor(this.model, row, line.tokens.length - 1);
        }
    }

    /**
     * Executes a block of code, during which any edits that are performed on the document will be created with Undo support.
     * This should happen almost all of the time- in fact the only time it shouldn't is when replaying undo/redo operations.
     *
     * FIXME: Perhaps this should be "withoutUndo"?
     *
     * @param body the code to execute.
     */
    withUndo(body: () => void) {
        let oldUndo = this.model.recordingUndo;
        try {
            this.model.recordingUndo = true;
            this.model.undoManager.withUndo(body)
        } finally {
            this.model.recordingUndo = oldUndo;
        }
    }

    /**
     * Inserts a string at the current cursor location.
     *
     * @param text the text to insert
     */
    insertString(text: string) {
        this.withUndo(() => {
            let cs = Math.min(this.selectionLeft, this.selectionRight);
            let ce = Math.max(this.selectionLeft, this.selectionRight);
            this.model.edit([
                new ModelEdit('changeRange', [cs, ce, text, [cs, ce], [cs + text.length, cs + text.length]])
            ], { selection: new ModelEditSelection(cs + text.length) });
            this.repaint();
            this.caretX = this.model.getRowCol(this.selectionRight)[1];
        });
    }

    clearCompletion() {
        let evt: CompletionEvent = { type: "clear" }
        this._completionListeners.forEach(x => x(evt));
    }

    maybeShowCompletion() {
        if (this.getTokenCursor().offsetStart == this.selectionRight && !this.getTokenCursor().previous().isWhiteSpace()) {
            let evt: CompletionEvent = { type: "show", position: this.selectionRight, toplevel: this.model.getText(0, this.model.maxOffset) }
            this._completionListeners.forEach(x => x(evt));
        } else
            this.clearCompletion();
    }

    /**
     * Moves the caret left one character, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretLeft(clear: boolean = true) {
        this.clearCompletion();
        if (clear && this.selectionLeft != this.selectionRight) {
            if (this.selectionLeft < this.selectionRight)
                this.selectionRight = this.selectionLeft;
            else
                this.selectionLeft = this.selectionRight;
        } else {
            this.selectionRight--;
            if (clear)
                this.selectionLeft = this.selectionRight;
        }
        this.repaint();
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
    }

    /**
     * Moves the caret right one character, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretRight(clear: boolean = true) {
        this.clearCompletion();
        if (clear && this.selectionLeft != this.selectionRight) {
            if (this.selectionLeft > this.selectionRight)
                this.selectionRight = this.selectionLeft;
            else
                this.selectionLeft = this.selectionRight;
        } else {
            this.selectionRight++
            if (clear)
                this.selectionLeft = this.selectionRight;
        }
        this.repaint();
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
    }

    /**
     * Moves the caret to the beginning of the document, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretHomeAll(clear: boolean = true) {
        this.clearCompletion();
        this.selectionRight = 0;
        if (clear)
            this.selectionLeft = this.selectionRight;
        this.repaint();
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
    }

    /**
     * Moves the caret to the end of the document, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretEndAll(clear: boolean = true) {
        this.clearCompletion();
        this.selectionRight = this.model.maxOffset;
        if (clear)
            this.selectionLeft = this.selectionRight;
        this.repaint();
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
    }

    /**
     * Moves the caret to the beginning of the line, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretHome(clear: boolean = true) {
        this.clearCompletion();
        let [row, col] = this.model.getRowCol(this.selectionRight);
        this.selectionRight = this.selectionRight - col;
        if (clear)
            this.selectionLeft = this.selectionRight;
        this.repaint();
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
    }

    /**
     * Moves the caret to the end of the line, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretEnd(clear: boolean = true) {
        this.clearCompletion();
        let [row, col] = this.model.getRowCol(this.selectionRight);
        this.selectionRight = this.selectionRight - col + this.model.lines[row].text.length;
        if (clear)
            this.selectionLeft = this.selectionRight;
        this.repaint();
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
    }

    /**
     * Moves the caret to the previous line, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretUp(clear: boolean = true) {
        this.clearCompletion();
        let [row, col] = this.model.getRowCol(this.selectionRight);
        if (row > 0) {
            let len = this.model.lines[row - 1].text.length;
            this.selectionRight = this.model.getOffsetForLine(row - 1) + Math.min(this.caretX, len);
        } else {
            this.selectionRight = 0;
        }
        if (clear)
            this.selectionLeft = this.selectionRight;
        this.repaint();
    }

    /**
     * Moves the caret to the next line, using text editor semantics.
     *
     * @param clear if true, clears the current selection, if any, otherwise moves `cursorEnd` only.
     */
    caretDown(clear: boolean = true) {
        this.clearCompletion();
        let [row, col] = this.model.getRowCol(this.selectionRight);
        if (row < this.model.lines.length - 1) {
            let len = this.model.lines[row + 1].text.length;
            this.selectionRight = this.model.getOffsetForLine(row + 1) + Math.min(this.caretX, len);
        } else {
            this.selectionRight = this.model.maxOffset;
        }
        if (clear)
            this.selectionLeft = this.selectionRight;
        this.repaint();
    }

    /**
     * Deletes the current selection.
     *
     * FIXME: this should just be `changeRange`
     */
    private deleteSelection() {
        this.withUndo(() => {
            if (this.selectionLeft != this.selectionRight) {
                this.model.deleteRange(Math.min(this.selectionLeft, this.selectionRight), Math.max(this.selectionLeft, this.selectionRight) - Math.min(this.selectionLeft, this.selectionRight));
                this.selectionLeft = this.selectionRight = Math.min(this.selectionLeft, this.selectionRight);
            }
        })
    }

    /**
     * Retrieve the current selection as text.
     *
     */
    getSelectionText() {
        if (this.selectionLeft != this.selectionRight) {
            return this.model.getText(Math.min(this.selectionLeft, this.selectionRight), Math.max(this.selectionLeft, this.selectionRight))
        }
        return "";
    }

    /**
     * If there is no selection- deletes the character to the left of the cursor and moves it back one character.
     *
     * If there is a selection, deletes the selection.
     */
    backspace() {
        this.withUndo(() => {
            if (this.selectionLeft != this.selectionRight) {
                this.deleteSelection();
            } else {
                if (this.selectionRight > 0) {
                    this.model.deleteRange(this.selectionRight - 1, 1, [this.selectionLeft, this.selectionRight], [this.selectionRight - 1, this.selectionRight - 1]);
                    this.selectionRight--;
                }
                this.selectionLeft = this.selectionRight;
            }
            this.repaint()
            this.caretX = this.model.getRowCol(this.selectionRight)[1];
        });
    }

    /**
     * If there is no selection- deletes the character to the right of the cursor.
     *
     * If there is a selection, deletes the selection.
     */
    delete() {
        this.withUndo(() => {
            if (this.selectionLeft != this.selectionRight) {
                this.deleteSelection();
            } else {
                this.model.deleteRange(this.selectionRight, 1);
                this.selectionLeft = this.selectionRight;
            }
            this.caretX = this.model.getRowCol(this.selectionRight)[1];
            this.repaint()
        });
    }

    /**
     * Construct a selection marker div.
     * @param start the left hand side start position in pixels.
     * @param width the width of the marker, in pixels.
     */
    private makeSelection(start: number, width: number) {
        let div = document.createElement("div")
        div.className = "sel-marker";
        let left = start;
        div.style.left = left + "px";
        div.style.width = width + "px";
        return div;
    }

    /**
     * If we are rendering a matched parenthesis, a cursor pointing at the close parenthesis.
     */
    closeParen: TokenCursor;

    /**
     * If we are rendering a matched parenthesis, a cursor pointing at the open parenthesis.
     */
    openParen: TokenCursor;

    /**
     * True if we are rendering a matched parenthesis.
     */
    matchingParen = false;

    /**
     * Clears the rendering for matching parenthesis.
     */
    private clearParenMatches() {
        let cp = this.getElementForToken(this.closeParen);
        if (cp) {
            cp.classList.remove("match");
            cp.classList.remove("match-fail");
        }

        let op = this.getElementForToken(this.openParen);
        if (op) {
            op.classList.remove("match");
            op.classList.remove("match-fail");
        }
        this.closeParen = null;
        this.openParen = null;
    }

    /**
     * Sets the rendering for matching parenthesis.
     */
    updateParenMatches() {
        let cursor = this.getTokenCursor();

        if (cursor.getPrevToken().type == "close") {
            this.closeParen = cursor.clone().previous();
            if (cursor.backwardSexp()) {
                this.openParen = cursor;
                this.matchingParen = true;
            }
            if (this.closeParen && this.openParen)
                this.matchingParen = validPair(this.openParen.getToken().raw, this.closeParen.getToken().raw);
            else {
                this.matchingParen = false;
            }

        } else if (cursor.getToken().type == "open") {
            this.openParen = cursor.clone();
            if (cursor.forwardSexp()) {
                this.closeParen = cursor.previous();
                this.matchingParen = true;
            }
            if (this.closeParen && this.openParen)
                this.matchingParen = validPair(this.openParen.getToken().raw, this.closeParen.getToken().raw);
            else {
                this.matchingParen = false;
            }
        }

        let cp = this.getElementForToken(this.closeParen);
        if (cp) {
            if (this.matchingParen) {
                cp.classList.add("match");
            }
            else {
                cp.classList.add("fail-match")
            }
        }

        let op = this.getElementForToken(this.openParen);
        if (op) {
            if (this.matchingParen) {
                op.classList.add("match");
            }
            else {
                op.classList.add("fail-match")
            }
        }
    }

    /**
     * Given a TokenCursor, returns the HTMLElement that is rendered for this token.
     * @param cursor
     */
    private getElementForToken(cursor: TokenCursor) {
        if (cursor && this.inputLines[cursor.line])
            return this.inputLines[cursor.line].querySelector(".content").children.item(cursor.token) as HTMLElement
    }

    private _repaintListeners = [];
    addOnRepaintListener(fn: () => void) {
        this._repaintListeners.push(fn);
    }

    /**
     * Update the DOM for the editor. After a change in the model or local editor information (e.g. cursor position), we apply the changes,
     * attempting to minimize the work.
     */
    repaint() {
        this.clearParenMatches();
        this.model.flushChanges()
        // remove any deleted lines
        for (let [start, count] of this.model.deletedLines) {
            for (let j = 0; j < count; j++)
                this.mainElem.removeChild(this.inputLines[start + j]);
            this.inputLines.splice(start, count);
        }
        this.model.deletedLines.clear();

        // insert any new lines
        for (let [start, count] of this.model.insertedLines) {
            for (let j = 0; j < count; j++) {
                let line = this.makeLine()
                if (!this.inputLines[start + j])
                    this.mainElem.append(line);
                else
                    this.mainElem.insertBefore(line, this.inputLines[start + j]);

                this.inputLines.splice(start + j, 0, line)
            }
        }
        this.model.insertedLines.clear();

        // update changed lines
        for (let line of this.model.changedLines) {
            let ln = this.inputLines[line].querySelector(".content");
            while (ln.firstChild)
                ln.removeChild(ln.firstChild);
            for (let tk of this.model.lines[line].tokens) {
                if (!tk)
                    break;
                ln.appendChild(makeToken(tk));
            }
            if (!ln.firstChild)
                ln.appendChild(document.createTextNode(" ")) // otherwise the line will collapse to height=0 due to html fun.
        }
        this.model.changedLines.clear();

        // reposition the caret
        let [row, col] = this.model.getRowCol(this.selectionRight);
        this.inputLines[row].appendChild(this.caret);
        let style = getComputedStyle(this.inputLines[row]);
        ctx.font = style.fontStyle + " " + style.fontSize + " " + style.fontFamily;

        this.caret.style.left = measureText(this.model.lines[row].text.substr(0, col)) + "px";

        let startLine = this.model.getRowCol(Math.min(this.lastSelectionStart, this.lastSelectionEnd, this.selectionLeft, this.selectionRight));
        let endLine = this.model.getRowCol(Math.max(this.lastSelectionStart, this.lastSelectionEnd, this.selectionLeft, this.selectionRight));

        let cs = this.model.getRowCol(Math.min(this.selectionLeft, this.selectionRight));
        let ce = this.model.getRowCol(Math.max(this.selectionLeft, this.selectionRight));

        let lcs = this.model.getRowCol(Math.min(this.lastSelectionStart, this.lastSelectionEnd));
        let lce = this.model.getRowCol(Math.max(this.lastSelectionStart, this.lastSelectionEnd));

        // update the selection
        for (let line = startLine[0]; line <= endLine[0]; line++) {
            let ln = this.inputLines[line].querySelector(".selection");
            if (line < cs[0] || line > ce[0]) {
                // definitely outside the selection, nuke all the selection divs.
                while (ln.firstChild)
                    ln.removeChild(ln.firstChild);
            } else if (line == cs[0] && line == ce[0]) {
                // this selection is exactly 1 line, and we're at it.
                while (ln.firstChild)
                    ln.removeChild(ln.firstChild);
                let left = measureText("M") * cs[1];
                ln.appendChild(this.makeSelection(left, measureText("M") * ce[1] - left));
            } else if (line == cs[0]) {
                // this is the first line of the selection
                while (ln.firstChild)
                    ln.removeChild(ln.firstChild);
                let left = measureText("M") * cs[1];
                ln.appendChild(this.makeSelection(left, measureText("M") * this.model.lines[line].text.length - left));
            } else if (line == ce[0]) {
                // this is the last line of the selection
                while (ln.firstChild)
                    ln.removeChild(ln.firstChild);
                ln.appendChild(this.makeSelection(0, measureText("M") * ce[1]));
            } else if (line > cs[0] && line < ce[0]) {
                // this line is within the selection, but is not the first or last.
                if (line > lcs[0] && line < lce[0]) {
                    // this line was within the selection previously, it is already highlighted,
                    // nothing to do.
                } else if (line >= cs[0] && line <= ce[0]) {
                    // this line is newly within the selection
                    while (ln.firstChild)
                        ln.removeChild(ln.firstChild);
                    ln.appendChild(this.makeSelection(0, Math.max(measureText("M"), measureText("M") * this.model.lines[line].text.length)));
                } else {
                    // this line is no longer within the selection
                    while (ln.firstChild)
                        ln.removeChild(ln.firstChild);
                }
            }
        }

        this.lastSelectionStart = this.selectionLeft;
        this.lastSelectionEnd = this.selectionRight;

        this.updateParenMatches()
        this._repaintListeners.forEach(x => x());
    }

    getCaretOnScreen() {
        let rect = this.caret.getBoundingClientRect();
        return { x: rect.left, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
    }

    /** Given a (pageX, pageY) pixel coordinate, returns the character offset into this document. */
    pageToOffset(pageX: number, pageY: number) {
        let rect = this.mainElem.getBoundingClientRect();
        let y = pageY - (rect.top + window.scrollY);
        let x = pageX - (rect.left + window.scrollX);
        let i: number;

        // NOTE: assuming every line is a fixed size, this could be O(1).
        // on the other hand, this seems quite fast for now.
        for (i = 0; i < this.mainElem.children.length; i++) {
            let child = this.mainElem.children.item(i) as HTMLElement;
            if (y < child.offsetTop)
                break;
        }
        i--;

        if (i < 0)
            return 0;
        let offset = this.model.getOffsetForLine(i);

        offset += Math.min(Math.floor(x / measureText("M")), this.model.lines[i].text.length)
        return offset;
    }

    /** Given a (pageX, pageY) pixel coordinate, returns if the point is in the bounding rectangle of the main element. */
    withinBoundingClientRect(pageX: number, pageY: number) {
        let rect = this.mainElem.getBoundingClientRect();
        let rectY = (rect.top + window.scrollY);
        let rectX = (rect.left + window.scrollX);
        if (pageX >= rectX &&
            pageX <= rectX + rect.width &&
            pageY >= rectY &&
            pageY <= rectY + rect.height) {
            return true;
        }
        return false;
    }

    private mouseDrag = (e: MouseEvent) => {
        this.selectionRight = this.pageToOffset(e.pageX, e.pageY)
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
        this.repaint();
    }

    private mouseUp = (e: MouseEvent) => {
        window.removeEventListener("mousemove", this.mouseDrag)
        window.removeEventListener("mouseup", this.mouseUp)
    }

    private mouseDown = (e: MouseEvent) => {
        e.preventDefault();

        this.selectionLeft = this.selectionRight = this.pageToOffset(e.pageX, e.pageY)
        this.caretX = this.model.getRowCol(this.selectionRight)[1];
        this.repaint();

        window.addEventListener("mousemove", this.mouseDrag)
        window.addEventListener("mouseup", this.mouseUp)
    }

    focus = (e: Event) => { e.preventDefault(); this.input.focus() };

    public mainElem: HTMLElement;
    public promptElem: HTMLElement;
    elem: HTMLElement;
    wrap: HTMLElement;

    constructor(public parent: HTMLElement, prompt: string, public input: HTMLInputElement) {
        const editorFontSize = getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-size'); // https://github.com/microsoft/vscode/issues/86722
        this.wrap = this.elem = document.createElement("div");
        this.wrap.className = "prompt-wrap";
        if (!editorFontSize.endsWith('px')) {
            this.parent.setAttribute('style', `font-size: ${editorFontSize}px;`);
        }
        this.wrap.addEventListener("mousedown", this.focus);
        this.wrap.addEventListener("touchstart", this.focus);
        this.promptElem = document.createElement("div");
        this.promptElem.className = "prompt"
        this.promptElem.textContent = prompt;

        this.mainElem = document.createElement("div");
        this.wrap.appendChild(this.promptElem);
        this.wrap.appendChild(this.mainElem);

        parent.appendChild(this.wrap);
        this.mainElem.addEventListener("mousedown", this.mouseDown)

        this.caret = document.createElement("div");
        this.caret.className = "caret";
        if (!editorFontSize.endsWith('px')) {
            this.caret.setAttribute('style', `height: ${editorFontSize}px;`);
        }
        let line = this.makeLine();
        this.inputLines.push(line)
        this.mainElem.appendChild(line);
        ctx.font = getComputedStyle(line).font + "";
        this.caret.style.width = measureText("M") + "px";
        line.appendChild(this.caret);
    }

    private makeLine() {
        let line = document.createElement("div");
        line.className = "line";

        let content = document.createElement("div");
        content.className = "content";
        line.append(content);

        let selection = document.createElement("div");
        selection.className = "selection";
        line.append(selection);
        return line;
    }

    public canReturn() {
        return this.selectionRight == this.selectionLeft && this.selectionRight == this.model.maxOffset;
    }

    public freeze() {
        this.mainElem.removeEventListener("mousedown", this.mouseDown)
        window.removeEventListener("mouseup", this.mouseUp)
        window.removeEventListener("mousemove", this.mouseDrag);
        this.wrap.removeEventListener("mousedown", this.focus);
        this.wrap.removeEventListener("touchstart", this.focus);
        this.input.disabled = true;

        this.selectionLeft = this.selectionRight = this.model.maxOffset;
        this.repaint();
        this.caret.parentElement.removeChild(this.caret);
    }

    public doReturn() {
        this.freeze();
    }

    selectionStack: ModelEditSelection[] = [];
}

/**
 * A set of tokens which should be highlighted as macros.
 * this is, of course, a really stupid way of doing it.
 */
const macros = new Set(["if", "let", "do", "while", "cond", "case"]);

/**
 * Constructs an HTMLElement to represent a token with the correct syntax highlighting.
 * @param tk the token to construct.
 */
function makeToken(tk: Token) {
    let span = document.createElement("span");
    let className = tk.type;
    if (tk.type == "id") {
        if (tk.raw.startsWith("def"))
            className = "decl";
        else if (macros.has(tk.raw))
            className = "macro";
    }

    span.textContent = tk.raw;
    span.className = className;
    return span;
}