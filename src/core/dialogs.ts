import { Dialog } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';

/**
 * The renderer every dialog of this extension is built with. It marks the
 * footer, and `style/base.css` scopes its dialog rules - no focus rim on any
 * button, the reject buttons (Cancel, and Close in the Open Callback popup) as
 * secondary surface buttons so the fill alone marks the primary - to a dialog
 * that holds the mark, so JupyterLab's own
 * dialogs keep their look. A renderer is the one hook that also reaches the
 * dialogs JupyterLab builds on our behalf: `InputDialog.getText` passes its
 * options through, and takes no class.
 */
export class DialogRenderer extends Dialog.Renderer {
  createFooter(
    buttons: ReadonlyArray<HTMLElement>,
    checkbox: HTMLElement | null
  ): Widget {
    const footer = super.createFooter(buttons, checkbox);
    footer.addClass('jp-AiAssistantsPanel-dialogFooter');
    return footer;
  }
}

export const dialogRenderer = new DialogRenderer();
