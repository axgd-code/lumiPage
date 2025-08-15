// ==UserScript==
// @name         Toggle Info JSON Copier (universal + observer + mat-option safe)
// @namespace    http://tampermonkey.net/
// @version      4.4
// @description  Ajoute un bouton ℹ️ pour copier un JSON formaté (rouge=cliquables, orange=mat-icon, bleu=textes). Fonctionne sur toute URL, SPA et overlays (mat-option).
// @author       Vous
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  // --- State ---
  let active = false;
  let observer = null;
  let processed = new WeakSet(); // éléments déjà traités
  const injectedNodes = []; // wrappers/boutons injectés à retirer
  const HIGHEST_Z = 2147483647;

  // --- Styles centralisés (évite les styles inline qui peuvent être bloqués par CSP) ---
  GM_addStyle(`
    .tm-wrapper{display:inline-flex;align-items:center;gap:4px;margin:2px;}
    .tm-outline-red{outline:2px solid red !important;}
    .tm-outline-orange{outline:2px solid orange !important;}
    .tm-outline-blue{outline:2px solid blue !important;}
    .tm-btn{padding:1px 4px;border:0;background:transparent;cursor:pointer;font-size:12px;line-height:1;}
    .tm-msg{display:none;margin-left:4px;font-size:.8em;color:green;}
    .tm-floating{position:fixed;bottom:14px;right:14px;z-index:${HIGHEST_Z};background:#111;color:#fff;
                 border-radius:8px;padding:10px 12px;border:1px solid #333;box-shadow:0 6px 18px rgba(0,0,0,.25);
                 font:500 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}
    .tm-floating .title{font-weight:700;margin-bottom:6px;}
    .tm-floating .legend{font-size:11px;opacity:.85;margin-bottom:8px}
    .tm-floating .action{display:flex;gap:8px}
    .tm-floating button{all:unset;background:#2c7be5;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer}
    .tm-floating button.secondary{background:#2e2e2e}
    .tm-floating button.secondary:disabled{cursor: not-allowed; opacity: 0.6;} /* Nouvelle règle */
  `);

  // --- Utils ---
  function getCssSelector(el){
    if(!(el instanceof Element))return null;
    const path=[];
    while(el && el.nodeType===Node.ELEMENT_NODE){
      let selector=el.nodeName.toLowerCase();
      if(el.id){ path.unshift(`${selector}#${el.id}`); break; }
      let sib=el, nth=1;
      while((sib=sib.previousElementSibling)){ if(sib.nodeName.toLowerCase()===selector) nth++; }
      if(nth!==1) selector+=`:nth-of-type(${nth})`;
      path.unshift(selector);
      el=el.parentElement;
    }
    return path.join(' > ');
  }

  function getXPath(el){
    if(el.id) return `//*[@id="${el.id}"]`;
    const parts=[];
    while(el && el.nodeType===Node.ELEMENT_NODE){
      let i=0, sib=el.previousSibling;
      while(sib){ if(sib.nodeType!==Node.DOCUMENT_TYPE_NODE && sib.nodeName===el.nodeName) i++; sib=sib.previousSibling; }
      parts.unshift(el.nodeName.toLowerCase() + (i?`[${i+1}]`:""));
      el=el.parentElement;
    }
    return "/"+parts.join("/");
  }

  function getElementLabel(el){
    let t="";
    if(el.id){
      const label=document.querySelector(`label[for="${el.id}"]`);
      if(label) t=label.innerText.trim();
    }
    if(!t){
      const parentLabel=el.closest('label');
      if(parentLabel) t=parentLabel.innerText.trim();
    }
    if(!t && ["button","a"].includes(el.tagName.toLowerCase())) t=el.innerText.trim();
    if(!t && el.placeholder) t=el.placeholder.trim();
    if(!t) t=(el.innerText||el.textContent||"").trim();
    return t||null;
  }

  function getDescription(el){
    return el.getAttribute?.('aria-label')?.trim()
        || el.getAttribute?.('title')?.trim()
        || el.innerText?.trim()
        || el.textContent?.trim()
        || null;
  }

  function getElementType(el){
    const tag=el.tagName.toLowerCase();
    if(tag==='a') return 'link';
    if(tag==='button' || el.getAttribute('role')==='button') return 'button';
    if(tag==='input') return `input-${el.type||'text'}`;
    if(tag==='textarea') return 'textarea';
    if(tag==='select') return 'select';
    if(tag==='option') return 'option';
    if(tag==='mat-option') return 'mat-option';
    if(tag==='mat-icon') return 'mat-icon';
    return tag;
  }

  function isMultipleElement(el){
    const tag=el.tagName.toLowerCase();
    if(tag==='option' || tag==='mat-option') return true;
    if(tag==='input'){
      const t=(el.type||'').toLowerCase();
      return t==='radio' || t==='checkbox';
    }
    return false;
  }

  function hasAngularClick(el){
    for(let cur=el; cur && cur.nodeType===Node.ELEMENT_NODE; cur=cur.parentElement){
      if(cur.getAttribute && cur.getAttribute('(click)')!==null) return true;
    }
    return false;
  }

  function isInsideClickable(el){
    if(el.closest?.('a[href],button,[role="button"],[onclick],[tabindex],[ng-click]')) return true;
    return hasAngularClick(el);
  }

  function isClickable(el){
    const tag=el.tagName.toLowerCase();
    if(tag==='a' && el.hasAttribute('href')) return true;
    if(tag==='button') return true;
    if(tag==='input' && (el.type||'')!=='hidden') return true;
    if(tag==='select' || tag==='textarea') return true;
    if(tag==='mat-option' || (el.getAttribute?.('role')==='option')) return true;
    if(el.getAttribute?.('role')==='button') return true;
    if(el.hasAttribute?.('onclick') || el.hasAttribute?.('ng-click')) return true;
    if(el.style && el.style.cursor==='pointer') return true;
    if(el.classList?.contains('mat-mdc-menu-trigger')) return true;
    if(hasAngularClick(el)) return true;
    return false;
  }

  function hasText(el){
    const t=(el.innerText||el.textContent||'').trim();
    return t.length>0;
  }

  async function copyToClipboard(text){
    try{
      await navigator.clipboard.writeText(text);
      return true;
    }catch(e){
      try{
        if(typeof GM_setClipboard==='function'){ GM_setClipboard(text); return true; }
      }catch(_){}
      // Fallback textarea
      try{
        const ta=document.createElement('textarea');
        ta.value=text; ta.style.position='fixed'; ta.style.top='-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        return true;
      }catch(_){}
      return false;
    }
  }

  // --- Création des contrôles ---
  function createInfoButton(el, category){
    const btn=document.createElement('button');
    btn.className='tm-btn'; btn.textContent='ℹ️'; btn.title='Copier infos JSON';

    const msg=document.createElement('span');
    msg.className='tm-msg'; msg.textContent='Copié !';

    btn.addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      const data=getElementData(el, category);
      const ok=await copyToClipboard(JSON.stringify(data,null,2));
      msg.style.display= ok ? 'inline' : 'inline';
      if(!ok) msg.textContent='Échec copie';
      setTimeout(()=>{ msg.style.display='none'; msg.textContent='Copié !'; }, 1800);
    });

    const container=document.createElement('span');
    container.className='tm-wrapper';
    container.appendChild(btn);
    container.appendChild(msg);
    injectedNodes.push(container);
    return container;
  }

  function getElementData(el, category) {
      return {
        label: getElementLabel(el),
        description: getDescription(el),
        id: el.id || null,
        css: getCssSelector(el),
        xpath: getXPath(el),
        multiple_elements: isMultipleElement(el),
        tags: '@' + (document.title||'').trim(),
        type: getElementType(el),
        category
      };
  }

  // Pour éviter de casser certains composants (option/mat-option), on n’enveloppe pas : on ajoute à côté.
  function attachControls(el, borderClass, category){
    if(processed.has(el)) return;
    processed.add(el);
    el.classList.add(borderClass);

    const tag=el.tagName.toLowerCase();
    const risky = tag==='option' || tag==='mat-option';

    if(risky){
      const controls=createInfoButton(el, category);
      if(el.parentNode){
        el.parentNode.insertBefore(controls, el.nextSibling);
      }
      return;
    }

    // Stratégie par défaut : wrapper
    if(!el.parentNode) return;
    const wrapper=document.createElement('span');
    wrapper.className='tm-wrapper';
    el.parentNode.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    const controls=createInfoButton(el, category);
    wrapper.appendChild(controls);
    injectedNodes.push(wrapper);
  }

  // --- Scan d’un sous-arbre ---
  function scan(root=document.body){
    if(!root || !(root instanceof Element)) return;

    // Éléments cliquables (inclut mat-option/role=option)
    root.querySelectorAll('a[href], button, [role="button"], [onclick], [tabindex], input:not([type="hidden"]), select, textarea, option, mat-option, [role="option"]')
      .forEach(el=>{
        if(el.closest('.tm-wrapper') || el.closest('.tm-floating')) return;
        attachControls(el, 'tm-outline-red', 'clickable');
      });

    // mat-icon cliquables/menus
    root.querySelectorAll('mat-icon').forEach(el=>{
      if(el.closest('.tm-wrapper') || el.closest('.tm-floating')) return;
      const clickable = isClickable(el) || el.classList.contains('mat-mdc-menu-trigger') || el.getAttribute('aria-haspopup')!==null;
      const inside = isInsideClickable(el);
      if(clickable && (!inside || el.classList.contains('mat-mdc-menu-trigger'))){
        attachControls(el, 'tm-outline-orange', 'clickable-icon');
      }
    });

    // Textes non cliquables
    root.querySelectorAll('span, p, div, h1, h2, h3, h4, h5, h6, td, th, li')
      .forEach(el=>{
        if(el.closest('.tm-wrapper') || el.closest('.tm-floating')) return;
        if(!hasText(el)) return;
        if(isInsideClickable(el)) return;

        const isHeading=/^h[1-6]$/i.test(el.tagName);
        if(isHeading){
          attachControls(el, 'tm-outline-blue', 'text');
          return;
        }

        const hasClickableChild = el.querySelector('a, button, [role="button"], [onclick], [ng-click], input:not([type="hidden"]), select, textarea, [role="option"], option');
        if(hasClickableChild) return;

        const simpleTags=['span','p','td','th','li'];
        const isSimple = simpleTags.includes(el.tagName.toLowerCase());
        const hasStructuralChild = el.querySelector('div, h1, h2, h3, h4, h5, h6');
        if(isSimple || !hasStructuralChild){
          attachControls(el, 'tm-outline-blue', 'text');
        }
      });
  }

  // --- Observer pour DOM dynamique (SPA, overlays, etc.) ---
  function startObserver(){
    if(observer) return;
    observer=new MutationObserver(muts=>{
      if(!active) return;
      for(const m of muts){
        for(const n of m.addedNodes){
          if(n.nodeType===1) scan(n);
        }
      }
    });
    observer.observe(document.documentElement, {childList:true, subtree:true});
  }
  function stopObserver(){ if(observer){ observer.disconnect(); observer=null; } }

  // --- Cleanup ---
  function cleanup(){
    // Retirer wrappers/boutons
    for(const node of injectedNodes.splice(0)){
      if(!node || !node.parentNode) continue;
      // si wrapper contient un élément original, le remettre en place
      if(node.classList && node.classList.contains('tm-wrapper')){
        const child=node.firstChild;
        // si le premier enfant est encore un élément original
        if(child && child.nodeType===1 && !child.classList?.contains('tm-btn')){
          node.parentNode.insertBefore(child, node);
        }
      }
      node.remove();
    }
    // Retirer outlines
    document.querySelectorAll('.tm-outline-red, .tm-outline-orange, .tm-outline-blue')
      .forEach(el=>el.classList.remove('tm-outline-red','tm-outline-orange','tm-outline-blue'));
    processed = new WeakSet();
  }

  // --- UI flottante ---
  function createFloatingUI(){
    if(document.querySelector('.tm-floating')) return;
    const ui=document.createElement('div');
    ui.className='tm-floating';
    ui.innerHTML=`
      <div class="title">Afficher les sélecteurs</div>
      <div class="legend">🔴 Cliquables &nbsp; 🟠 Non standard &nbsp; 🔵 Textes</div>
      <div class="action">
        <button class="toggle">Activer</button>
        <button class="get-all-clickable secondary" disabled>getAll cliquables</button>
        <button class="get-all-txt secondary" disabled>getAll txt</button>
      </div>
    `;
    const toggleBtn=ui.querySelector('.toggle');
    const getAllClickableBtn = ui.querySelector('.get-all-clickable');
    const getAllTxtBtn = ui.querySelector('.get-all-txt');

    toggleBtn.addEventListener('click', ()=>{
      active=!active;
      toggleBtn.textContent = active ? 'Désactiver' : 'Activer';
      // Mettre à jour l'état des boutons
      getAllClickableBtn.disabled = !active;
      getAllTxtBtn.disabled = !active;

      if(active){ scan(); startObserver(); }
      else { stopObserver(); cleanup(); }
    });

    getAllClickableBtn.addEventListener('click', async () => {
        const clickableElements = document.querySelectorAll('.tm-outline-red, .tm-outline-orange');
        const data = Array.from(clickableElements).map(el => getElementData(el, el.classList.contains('tm-outline-red') ? 'clickable' : 'clickable-icon'));
        const ok = await copyToClipboard(JSON.stringify(data, null, 2));
        getAllClickableBtn.textContent = ok ? 'Copié !' : 'Échec copie';
        setTimeout(() => getAllClickableBtn.textContent = 'getAll cliquables', 1800);
    });

    getAllTxtBtn.addEventListener('click', async () => {
        const textElements = document.querySelectorAll('.tm-outline-blue');
        const data = Array.from(textElements).map(el => getElementData(el, 'text'));
        const ok = await copyToClipboard(JSON.stringify(data, null, 2));
        getAllTxtBtn.textContent = ok ? 'Copié !' : 'Échec copie';
        setTimeout(() => getAllTxtBtn.textContent = 'getAll txt', 1800);
    });

    document.body.appendChild(ui);
  }

  // --- Init ---
  window.addEventListener('load', createFloatingUI);
})();