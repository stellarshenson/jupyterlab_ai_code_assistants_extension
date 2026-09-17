# ux-designer research

Fetched 2026-09-17. Reference = model knows it; open source only if unsure. Full entry = model did not know it; cite the quote.

## Row click: select or invoke

- [WAI-ARIA APG Listbox 2024](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) - Space toggles selection; selected state distinct from focus; selection-follows-focus degrades multi-select
- [WinUI ListView 2026](https://learn.microsoft.com/en-us/windows/apps/design/controls/listview-and-gridview) - Click selects under SelectionMode, invokes only under IsItemClickEnabled with SelectionMode None; one meaning per click
- [Sellen, Kurtenbach, Buxton 1992](https://www.billbuxton.com/ModeErrors.html): "Mode switch method accounted for 15.6% of the variance using the liberal criterion, and 11.0% using the conservative criterion. Visual feedback, however, accounted for only 4.8%." Rule: a mode the user holds (key down, pedal) prevents mode errors; a mode latched by a prior action and shown only visually does not. Tell: a list where the first tick flips every later row click from invoke to select is a latched mode with visual feedback only - expect mode errors; remedy is one click meaning with the checkbox as the selection control.
