// The one clipboard write behind every copy affordance in the app. `navigator.clipboard` exists only
// in a SECURE context — https, or localhost — and Ntwine is routinely read from neither: `--host`
// serves the board over plain http to a LAN address, which is exactly the origin a phone is reading.
// There the async API is simply undefined, and every surface that checked for it and gave up ("copy
// the command from a secure Ntwine page") was refusing the copy on the page the user actually had. The
// fallback is the classic one — select the text in an off-screen textarea and `execCommand("copy")` —
// which every engine still ships and which needs only the user activation the click already provides.
//
// The fallback also runs when `writeText` REJECTS (a focus/activation blip, a denied permission): the
// textarea path may still land the copy, and when it does the user never needs to hear about it.
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      /* fall through to the textarea path */
    }
  }
  if (!copyViaExecCommand(text)) throw new Error("the browser blocked clipboard access")
}

// The textarea must be in the live DOM and actually selected for execCommand to have anything to copy.
// `readonly` keeps iOS from popping the keyboard; fixed positioning keeps the page from scrolling to
// it; the explicit setSelectionRange is what makes the selection real on iOS, where select() alone is
// not enough. Whatever the user had selected is put back afterwards — a copy must not eat a selection.
function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.top = "0"
  textarea.style.left = "0"
  textarea.style.opacity = "0"
  document.body.append(textarea)
  const selection = document.getSelection()
  const prior = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  textarea.select()
  textarea.setSelectionRange(0, text.length)
  let copied = false
  try {
    copied = document.execCommand("copy")
  } catch {
    copied = false
  }
  textarea.remove()
  if (prior && selection) {
    selection.removeAllRanges()
    selection.addRange(prior)
  }
  return copied
}
