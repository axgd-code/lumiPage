# LumiPage: A Web Element Selection Tool

LumiPage is a user script (Tampermonkey) for developers and testers to quickly extract element data from any webpage.

## Features

  * **Visual Highlighting:** Elements are bordered with colors to indicate their type:
      * 🔴 **Red:** Clickable elements.
      * 🟠 **Orange:** Non-standard clickable icons.
      * 🔵 **Blue:** Text elements.
  * **Instant Copy:** An "ℹ️" button next to each element copies a JSON with its details (CSS, XPath, etc.).
  * **Bulk Copy:** Use the floating interface to copy all clickable or text elements at once into a single JSON array.
  * **Dynamic Page Support:** Works on SPAs and overlays using a `MutationObserver`.

-----

## Installation

1.  Install the **Tampermonkey** browser extension.
2.  Create a new user script.
3.  Copy and paste the code from `lumipage.js` and save.

-----

## Usage

1.  On any webpage, click **"Activate"** in the bottom-right floating menu.
2.  Click the "ℹ️" button on an element to copy its data.
3.  Use **"getAll cliquables"** or **"getAll txt"** for bulk copying.
4.  Click **"Deactivate"** to remove the highlights and buttons.

-----

## JSON Example
```json
{
  "label": "Element Name",
  "css": "body > div > button",
  "xpath": "/html/body/div[1]/button[1]",
  "type": "button",
  "category": "clickable"
}
```