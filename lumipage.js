// ==UserScript==
// @name         Lumipage 
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Ajoute un bouton ℹ️ pour copier un JSON formaté avec infos d'un élément (et surlignage rouge, orange, bleu), activable/désactivable via un menu flottant.
// @author       axgd-code
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // État d'activation
    let active = false;

    // Stockage des wrappers injectés (permet de les retirer facilement)
    const injectedContainers = [];

    /**
     * Retourne un sélecteur CSS unique pour un élément donné.
     */
    function getCssSelector(el) {
        if (!(el instanceof Element)) return null;
        const path = [];
        while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id) {
                selector += `#${el.id}`;
                path.unshift(selector);
                break;
            } else {
                let sib = el, nth = 1;
                while ((sib = sib.previousElementSibling)) {
                    if (sib.nodeName.toLowerCase() === selector) nth++;
                }
                if (nth !== 1) selector += `:nth-of-type(${nth})`;
            }
            path.unshift(selector);
            el = el.parentNode;
        }
        return path.join(' > ');
    }

    /**
     * Retourne un XPath pour un élément donné.
     */
    function getXPath(el) {
        if (el.id) return `//*[@id="${el.id}"]`;
        const parts = [];
        while (el && el.nodeType === Node.ELEMENT_NODE) {
            let index = 0;
            let sibling = el.previousSibling;
            while (sibling) {
                if (sibling.nodeType !== Node.DOCUMENT_TYPE_NODE && sibling.nodeName === el.nodeName) index++;
                sibling = sibling.previousSibling;
            }
            const tagName = el.nodeName.toLowerCase();
            const pathIndex = index ? `[${index + 1}]` : "";
            parts.unshift(tagName + pathIndex);
            el = el.parentNode;
        }
        return "/" + parts.join("/");
    }

    /**
     * Détecte le label pertinent d'un élément (label associé, texte, placeholder...).
     */
    function getElementLabel(el) {
        let labelText = "";

        // Label lié via "for"
        if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) labelText = label.innerText.trim();
        }

        // Label parent
        if (!labelText) {
            const parentLabel = el.closest('label');
            if (parentLabel) labelText = parentLabel.innerText.trim();
        }

        // Boutons et liens
        if (!labelText && ["button", "a"].includes(el.tagName.toLowerCase())) {
            labelText = el.innerText.trim();
        }

        // Placeholder
        if (!labelText && el.placeholder) {
            labelText = el.placeholder.trim();
        }

        // Texte brut
        if (!labelText) {
            labelText = (el.innerText || el.textContent || "").trim();
        }

        return labelText || null;
    }

    /**
     * Retourne un type générique pour un élément.
     */
    function getElementType(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
        if (tag === 'input') return `input-${el.type || 'text'}`;
        if (tag === 'textarea') return 'textarea';
        if (tag === 'select') return 'select';
        if (tag === 'option') return 'option';
        if (tag === 'mat-icon') return 'mat-icon';
        return 'text';
    }

    /**
     * Retourne true si l'élément est un groupe d'options : radio, checkbox ou option.
     */
    function isMultipleElement(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'option') return true;
        if (tag === 'input') {
            const type = (el.type || '').toLowerCase();
            return type === 'radio' || type === 'checkbox';
        }
        return false;
    }

    /**
     * Retourne true si l'élément est cliquable (onclick, ng-click, style cursor, etc.).
     */
    function isClickable(el) {
        return el.onclick !== null ||
               el.getAttribute('ng-click') !== null ||
               el.getAttribute('(click)') !== null ||
               el.style.cursor === 'pointer' ||
               el.getAttribute('role') === 'button' ||
               el.getAttribute('aria-haspopup') !== null ||
               el.classList.contains('mat-mdc-menu-trigger') ||
               el.classList.contains('clickable') ||
               el.closest('[onclick]') !== null ||
               el.closest('[ng-click]') !== null ||
               hasAngularClick(el);
    }

    /**
     * Détection de `(click)` dans les ancêtres (Angular).
     */
    function hasAngularClick(el) {
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            if (current.getAttribute('(click)') !== null) return true;
            current = current.parentElement;
        }
        return false;
    }

    /**
     * Détection de `(click)` dans les enfants (Angular).
     */
    function hasAngularClickChildren(el) {
        return [...el.querySelectorAll('*')].some(child => child.getAttribute('(click)') !== null);
    }

    /**
     * Retourne true si l'élément est à l'intérieur d'un élément cliquable.
     */
    function isInsideClickableElement(el) {
        if (el.closest('a[href], button, [role="button"], [onclick], [tabindex], [ng-click]')) return true;
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
            if (current.getAttribute('(click)') !== null) return true;
            current = current.parentElement;
        }
        return false;
    }

    /**
     * Retourne true si l'élément contient du texte visible.
     */
    function hasTextContent(el) {
        return (el.innerText || el.textContent || '').trim().length > 0;
    }

    /**
     * Crée un wrapper avec contour coloré et bouton ℹ️ qui copie le JSON.
     */
    function createWrapper(el, borderColor, elementCategory) {
        if (el.closest('.tm-wrapper')) return null;
        if (injectedContainers.some(c => c.contains(el))) return null;

        const wrapper = document.createElement('div');
        Object.assign(wrapper.style, {
            display: 'inline-flex',
            alignItems: 'center',
            outline: `2px solid ${borderColor}`,
            padding: '2px',
            margin: '2px'
        });
        wrapper.classList.add('tm-wrapper');
        wrapper.dataset.category = elementCategory;

        if (!el.parentNode) return null;

        // Insérer le wrapper autour de l'élément
        el.parentNode.insertBefore(wrapper, el);
        wrapper.appendChild(el);

        // Bouton ℹ️
        const btn = document.createElement('button');
        Object.assign(btn.style, {
            marginLeft: '4px',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '1px 4px'
        });
        btn.innerText = 'ℹ️';
        btn.classList.add('tm-info-btn');

        // Message "copié"
        const msg = document.createElement('span');
        Object.assign(msg.style, {
            color: 'green',
            marginLeft: '4px',
            fontSize: '12px',
            display: 'none'
        });
        msg.innerText = 'Copié !';

        // Action du bouton
        btn.addEventListener('click', async () => {
            const data = {
                label: getElementLabel(el),
                description: el.getAttribute('title')?.trim() || el.innerText?.trim() || null,
                id: el.id || null,
                css: getCssSelector(el),
                xpath: getXPath(el),
                multiple_elements: isMultipleElement(el),
                tags: '@' + (document.title || '').trim(),
                type: getElementType(el),
                category: elementCategory
            };
            try {
                await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                msg.style.display = 'inline';
                setTimeout(() => { msg.style.display = 'none'; }, 2000);
            } catch (e) {
                console.error('Erreur copie presse-papier', e);
            }
        });

        wrapper.appendChild(btn);
        wrapper.appendChild(msg);

        return wrapper;
    }

    /**
     * Injecte les wrappers ℹ️ autour des éléments ciblés.
     */
    function injectInfoButtons() {
        const container = document.querySelector('mat-drawer-container');
        if (!container) return;

        // 1. Éléments cliquables
        const clickableEls = container.querySelectorAll('a[href], button, [role="button"], [onclick], [tabindex], input, textarea, select, option');
        clickableEls.forEach(el => {
            const wrapper = createWrapper(el, 'red', 'clickable');
            if (wrapper) injectedContainers.push(wrapper);
        });

        // 2. mat-icon cliquables
        container.querySelectorAll('mat-icon').forEach(el => {
            const isClickableIcon = isClickable(el);
            const insideClickable = isInsideClickableElement(el);
            const hasOwnClick = el.classList.contains('mat-mdc-menu-trigger') ||
                                el.getAttribute('aria-haspopup') !== null ||
                                el.getAttribute('(click)') !== null;
            if ((isClickableIcon || hasOwnClick) && (!insideClickable || hasOwnClick)) {
                const wrapper = createWrapper(el, 'orange', 'clickable-icon');
                if (wrapper) injectedContainers.push(wrapper);
            }
        });

        // 3. Textes non cliquables
        container.querySelectorAll('span, p, div, h1, h2, h3, h4, h5, h6, td, th, li').forEach(el => {
            if (!hasTextContent(el) || isInsideClickableElement(el)) return;
            const isHeading = /^h[1-6]$/.test(el.tagName.toLowerCase());

            if (isHeading) {
                const wrapper = createWrapper(el, 'blue', 'text');
                if (wrapper) injectedContainers.push(wrapper);
            } else {
                const hasClickableChildren = el.querySelector('a, button, [role="button"], [onclick], [ng-click]') ||
                                             hasAngularClickChildren(el);
                if (!hasClickableChildren) {
                    const isSimple = ['span', 'p', 'td', 'th', 'li'].includes(el.tagName.toLowerCase());
                    const hasStructure = el.querySelectorAll('div, h1, h2, h3, h4, h5, h6').length > 0;
                    if (isSimple || !hasStructure) {
                        const wrapper = createWrapper(el, 'blue', 'text');
                        if (wrapper) injectedContainers.push(wrapper);
                    }
                }
            }
        });
    }

    /**
     * Retire tous les wrappers injectés.
     */
    function removeInfoButtons() {
        injectedContainers.forEach(wrapper => {
            const parent = wrapper.parentNode;
            const el = wrapper.querySelector(':not(.tm-info-btn):not(span)');
            if (el && parent) parent.insertBefore(el, wrapper);
            wrapper.remove();
        });
        injectedContainers.length = 0;
    }

    /**
     * Crée le menu flottant pour activer/désactiver l'outil.
     */
    function createToggleMenu() {
        const menu = document.createElement('div');
        Object.assign(menu.style, {
            position: 'fixed',
            bottom: '10px',
            right: '10px',
            backgroundColor: 'white',
            border: '1px solid black',
            padding: '10px',
            fontSize: '12px',
            zIndex: '9999',
            cursor: 'pointer',
            borderRadius: '5px',
            boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
        });
        menu.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 5px;">Toggle Selector Display</div>
            <div style="font-size: 10px;">
                🔴 Rouge : Éléments cliquables<br>
                🟠 Orange : Mat-icon cliquables<br>
                🔵 Bleu : Textes non-cliquables
            </div>
        `;
        menu.addEventListener('click', () => {
            active = !active;
            active ? injectInfoButtons() : removeInfoButtons();
        });
        document.body.appendChild(menu);
    }

    // Initialisation
    window.addEventListener('load', createToggleMenu);

})();
