"use strict";

/* =========================================================================
   Painel administrativo · LT Gloss
   - Login por senha, validada no servidor (Cloudflare Worker)
   - O Worker guarda o token do GitHub como segredo e publica no repositório
   - Nenhum segredo passa pelo navegador nem fica salvo neste código
========================================================================= */

const ADMIN = {
  workerUrl: "https://ltgloss-painel.indesignleandro.workers.dev",
  storageDraft: "ltg_admin_draft",
  assetsDir: "assets",
  maxImageSize: 1200,
};

const state = {
  password: null, // mantida só em memória durante a sessão
  products: [],
  dirty: false,
  editingIndex: -1,
  draft: null,
  pendingImages: {}, // nome do arquivo -> { dataUrl, width, height }
};

const $ = (id) => document.getElementById(id);

/* Ícones Lucide (mesmo padrão visual do projeto RASTREIO) */
const svgIcon = (paths) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  pencil: svgIcon(
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  ),
  arrowUp: svgIcon('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  arrowDown: svgIcon('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  copy: svgIcon(
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  ),
  trash: svgIcon(
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  ),
  x: svgIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  eye: svgIcon(
    '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  ),
  eyeOff: svgIcon(
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  ),
};

/* ------------------------------ Utilidades ------------------------------ */

const slugify = (text) =>
  String(text || "produto")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "produto";

const deepCopy = (value) => JSON.parse(JSON.stringify(value));

const hexToRgba = (hex, alpha) => {
  const value = String(hex || "").replace("#", "");
  const expanded = value.length === 3 ? value.replace(/./g, "$&$&") : value;
  const int = parseInt(expanded, 16);
  if (Number.isNaN(int) || expanded.length !== 6) {
    return `rgba(183, 95, 69, ${alpha})`;
  }
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
};

let toastTimer = null;
const toast = (message) => {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3600);
};

const showError = (id, message) => {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
};

/* --------------------------- API (Cloudflare) ---------------------------- */

const api = async (path, body = {}) => {
  const base = ADMIN.workerUrl.replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: state.password, ...body }),
    });
  } catch (error) {
    throw new Error("Não foi possível conectar ao servidor de publicação. Verifique a internet e tente de novo.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    /* corpo vazio */
  }
  if (!response.ok) {
    const err = new Error((data && data.message) || `Erro ${response.status}.`);
    err.status = response.status;
    throw err;
  }
  return data;
};

const loadProducts = async () => {
  const data = await api("/api/load");
  state.products = Array.isArray(data.products) ? data.products : [];
};

/* --------------------------- Rascunho local ------------------------------ */

const persistDraft = () => {
  const payload = { products: state.products, pendingImages: state.pendingImages };
  try {
    localStorage.setItem(ADMIN.storageDraft, JSON.stringify(payload));
  } catch (error) {
    try {
      localStorage.setItem(
        ADMIN.storageDraft,
        JSON.stringify({ products: state.products, pendingImages: {} }),
      );
    } catch (innerError) {
      /* sem espaço: rascunho só em memória */
    }
  }
};

const clearDraft = () => {
  localStorage.removeItem(ADMIN.storageDraft);
};

const restoreDraftIfAny = () => {
  const raw = localStorage.getItem(ADMIN.storageDraft);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    if (!Array.isArray(draft.products) || !draft.products.length) {
      clearDraft();
      return;
    }
    const restore = confirm(
      "Encontramos alterações não publicadas salvas neste navegador. Deseja restaurá-las?",
    );
    if (restore) {
      state.products = draft.products;
      state.pendingImages = draft.pendingImages || {};
      state.dirty = true;
    } else {
      clearDraft();
    }
  } catch (error) {
    clearDraft();
  }
};

const markDirty = () => {
  state.dirty = true;
  $("dirty-status").hidden = false;
  persistDraft();
};

const markClean = () => {
  state.dirty = false;
  $("dirty-status").hidden = true;
  clearDraft();
};

/* ------------------------------- Views ---------------------------------- */

const showView = (name) => {
  ["view-login", "view-panel"].forEach((id) => {
    $(id).hidden = id !== `view-${name}`;
  });
};

/* ------------------------- Card de pré-visualização ---------------------- */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const resolveImageSrc = (image) => {
  const src = image && image.src ? image.src : "";
  const name = src.split("/").pop();
  if (name && state.pendingImages[name]) {
    return state.pendingImages[name].dataUrl;
  }
  if (state.draft && state.draft.__pendingImage && src.endsWith(state.draft.__pendingImage.name)) {
    return state.draft.__pendingImage.dataUrl;
  }
  // O products.json guarda caminhos relativos à raiz do site ("./assets/...");
  // o painel roda em /admin/, então resolve a partir da raiz.
  return src.replace(/^\.\//, "/");
};

const buildOfferCard = (product, index) => {
  const colors = product.colors || {};
  const cta = product.cta || {};
  const image = product.image || {};
  const shade = product.shade || {};
  const accent = colors.accent || "#b75f45";

  const card = el("article", "offer-card is-dyn");
  if (product.featured) card.classList.add("is-featured");
  card.style.setProperty("--offer-accent", accent);
  card.style.setProperty("--offer-accent-dark", colors.accentDark || accent);
  card.style.setProperty("--offer-glow", hexToRgba(accent, 0.28));
  card.style.setProperty("--offer-soft", hexToRgba(accent, 0.22));
  card.style.setProperty("--offer-ring", hexToRgba(accent, 0.12));
  card.style.setProperty("--offer-border", hexToRgba(accent, 0.35));
  card.style.setProperty("--price-color", colors.price || "var(--ink)");
  card.style.setProperty("--cta-from", cta.from || "#271713");
  card.style.setProperty("--cta-to", cta.to || cta.from || "#271713");
  card.style.setProperty("--cta-text", cta.textColor || "#ffffff");

  const media = el("div", "offer-card__media");
  const img = document.createElement("img");
  img.src = resolveImageSrc(image);
  img.alt = image.alt || "";
  media.append(img);
  media.append(el("span", "offer-card__number", String(index + 1).padStart(2, "0")));
  if (product.tag) media.append(el("span", "offer-card__tag", product.tag));

  const content = el("div", "offer-card__content");
  if (product.promo) content.append(el("span", "offer-card__promo", product.promo));

  const dots = (Array.isArray(shade.dots) ? shade.dots : []).filter(Boolean);
  if (shade.label || dots.length) {
    const shadeRow = el("div", "offer-card__shade");
    if (dots.length) {
      const stack = el("span", "shade-stack");
      dots.forEach((color) => {
        const dot = el("span", "shade-dot");
        dot.style.background = color;
        stack.append(dot);
      });
      shadeRow.append(stack);
    }
    if (shade.label) shadeRow.append(el("span", "", shade.label));
    content.append(shadeRow);
  }

  const heading = el("h3", "", product.title ? `${product.title} ` : "");
  if (product.subtitle) heading.append(el("em", "", product.subtitle));
  content.append(heading);
  if (product.description) content.append(el("p", "", product.description));

  const price = el("div", "offer-card__price");
  if (product.oldPrice) {
    price.classList.add("offer-card__price--promo");
    price.append(el("span", "offer-card__old-price", product.oldPrice));
  }
  const amount = document.createElement("strong");
  amount.append(el("small", "", "R$"), document.createTextNode(` ${product.price || ""}`));
  price.append(amount);
  if (product.installments) price.append(el("span", "", product.installments));
  content.append(price);

  const link = el("a", "offer-card__cta", `${cta.text || "Comprar"} `);
  link.href = cta.href || "#";
  link.append(el("span", "", "↗"));
  content.append(link);

  card.append(media, content);
  return card;
};

/* --------------------------- Lista de produtos --------------------------- */

const renderList = () => {
  const list = $("product-list");
  list.textContent = "";

  const count = state.products.length;
  $("products-count").textContent = count
    ? `${count} produto${count > 1 ? "s" : ""} na seção de ofertas`
    : "Nenhum produto cadastrado";

  if (!count) {
    const empty = el("li", "list-empty", "Nenhum produto por aqui. Clique em “Adicionar produto” para começar.");
    list.append(empty);
    return;
  }

  state.products.forEach((product, index) => {
    const item = el("li", "product-item");

    const thumb = el("div", "product-item__thumb");
    const img = document.createElement("img");
    img.src = resolveImageSrc(product.image);
    img.alt = "";
    thumb.append(img, el("span", "num", String(index + 1).padStart(2, "0")));

    const info = el("div", "product-item__info");
    const name = el("span", "product-item__name", product.title ? `${product.title} ` : "");
    if (product.subtitle) name.append(el("em", "", product.subtitle));
    const meta = el("div", "product-item__meta");
    meta.append(el("strong", "product-item__price", `R$ ${product.price || "—"}`));
    if (product.tag) meta.append(el("span", "chip", product.tag));
    if (product.featured) meta.append(el("span", "chip chip--featured", "Destaque"));
    info.append(name, meta);

    const actions = el("div", "product-item__actions");
    const mkBtn = (icon, label, action, title) => {
      const button = el("button", label ? "btn btn--ghost btn--sm" : "btn btn--icon");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.index = String(index);
      button.title = title;
      button.setAttribute("aria-label", title);
      button.innerHTML = icon;
      if (label) {
        button.append(document.createTextNode(label));
      }
      return button;
    };
    actions.append(
      mkBtn(ICONS.pencil, "Editar", "edit", `Editar ${product.title || "produto"}`),
      mkBtn(ICONS.arrowUp, "", "up", "Mover para cima"),
      mkBtn(ICONS.arrowDown, "", "down", "Mover para baixo"),
      mkBtn(ICONS.copy, "", "dup", "Duplicar produto"),
      mkBtn(ICONS.trash, "", "del", "Excluir produto"),
    );

    item.append(thumb, info, actions);
    list.append(item);
  });
};

/* -------------------------------- Editor -------------------------------- */

const NEW_PRODUCT = {
  id: "",
  tag: "1 unidade",
  featured: false,
  promo: "",
  image: { src: "./assets/por-do-sol.webp", alt: "", width: 1086, height: 1448 },
  shade: { label: "", dots: ["#b75f45"] },
  title: "LT Gloss",
  subtitle: "",
  description: "",
  oldPrice: "",
  price: "",
  installments: "",
  colors: { accent: "#b75f45", accentDark: "#593426", price: "#271713" },
  cta: { text: "Comprar", href: "", from: "#b75f45", to: "#593426", textColor: "#ffffff" },
};

const setColor = (id, value, fallback) => {
  const input = $(id);
  const hex = /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : fallback;
  input.value = hex;
  const code = input.parentElement.querySelector("code");
  if (code) code.textContent = hex;
};

const renderDots = () => {
  const holder = $("dots-list");
  holder.textContent = "";
  const dots = state.draft.shade.dots || [];
  dots.forEach((color, index) => {
    const wrap = el("span", "dot-item");
    const input = document.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(color || "") ? color : "#b75f45";
    input.dataset.dotIndex = String(index);
    input.title = "Cor do tom";
    const remove = el("button", "");
    remove.type = "button";
    remove.innerHTML = ICONS.x;
    remove.dataset.dotRemove = String(index);
    remove.title = "Remover cor";
    remove.setAttribute("aria-label", "Remover cor");
    wrap.append(input, remove);
    holder.append(wrap);
  });
  $("btn-add-dot").hidden = dots.length >= 3;
};

const renderPreview = () => {
  const slot = $("preview-slot");
  slot.textContent = "";
  const index = state.editingIndex >= 0 ? state.editingIndex : state.products.length;
  slot.append(buildOfferCard(state.draft, index));
};

const populateForm = () => {
  const d = state.draft;
  $("f-title").value = d.title || "";
  $("f-subtitle").value = d.subtitle || "";
  $("f-description").value = d.description || "";
  $("f-tag").value = d.tag || "";
  $("f-promo").value = d.promo || "";
  $("f-featured").checked = Boolean(d.featured);
  $("f-shade-label").value = (d.shade && d.shade.label) || "";
  $("f-price").value = d.price || "";
  $("f-old-price").value = d.oldPrice || "";
  $("f-installments").value = d.installments || "";
  $("f-cta-text").value = (d.cta && d.cta.text) || "";
  $("f-cta-href").value = (d.cta && d.cta.href) || "";
  $("f-image-alt").value = (d.image && d.image.alt) || "";
  setColor("f-price-color", d.colors && d.colors.price, "#271713");
  setColor("f-cta-from", d.cta && d.cta.from, "#b75f45");
  setColor("f-cta-to", d.cta && d.cta.to, "#593426");
  setColor("f-cta-textcolor", d.cta && d.cta.textColor, "#ffffff");
  setColor("f-accent", d.colors && d.colors.accent, "#b75f45");
  setColor("f-accent-dark", d.colors && d.colors.accentDark, "#593426");
  $("editor-image-thumb").src = resolveImageSrc(d.image);
  renderDots();
  renderPreview();
};

const readForm = () => {
  const d = state.draft;
  d.title = $("f-title").value.trim();
  d.subtitle = $("f-subtitle").value.trim();
  d.description = $("f-description").value.trim();
  d.tag = $("f-tag").value.trim();
  d.promo = $("f-promo").value.trim();
  d.featured = $("f-featured").checked;
  d.shade.label = $("f-shade-label").value.trim();
  d.shade.dots = [...$("dots-list").querySelectorAll("input[type=color]")].map((i) => i.value);
  d.price = $("f-price").value.trim();
  d.oldPrice = $("f-old-price").value.trim();
  d.installments = $("f-installments").value.trim();
  d.cta.text = $("f-cta-text").value.trim();
  d.cta.href = $("f-cta-href").value.trim();
  d.cta.from = $("f-cta-from").value;
  d.cta.to = $("f-cta-to").value;
  d.cta.textColor = $("f-cta-textcolor").value;
  d.colors.accent = $("f-accent").value;
  d.colors.accentDark = $("f-accent-dark").value;
  d.colors.price = $("f-price-color").value;
  d.image.alt = $("f-image-alt").value.trim();
};

const openEditor = (index) => {
  state.editingIndex = index;
  state.draft = index >= 0 ? deepCopy(state.products[index]) : deepCopy(NEW_PRODUCT);
  if (!state.draft.shade) state.draft.shade = { label: "", dots: [] };
  if (!state.draft.colors) state.draft.colors = deepCopy(NEW_PRODUCT.colors);
  if (!state.draft.cta) state.draft.cta = deepCopy(NEW_PRODUCT.cta);
  if (!state.draft.image) state.draft.image = deepCopy(NEW_PRODUCT.image);
  $("editor-title").textContent = index >= 0 ? "Editar produto" : "Novo produto";
  showError("editor-error", "");
  populateForm();
  $("editor").hidden = false;
  document.body.style.overflow = "hidden";
  // Sempre abre no topo; foca sem rolar (e sem abrir o teclado no celular).
  document.querySelector(".drawer__body").scrollTop = 0;
  if (window.matchMedia("(min-width: 861px)").matches) {
    $("f-title").focus({ preventScroll: true });
  }
};

const closeEditor = () => {
  $("editor").hidden = true;
  document.body.style.overflow = "";
  state.draft = null;
  state.editingIndex = -1;
};

const saveProduct = () => {
  readForm();
  const d = state.draft;
  if (!d.title) {
    showError("editor-error", "Informe o nome do produto.");
    return;
  }
  if (!d.price) {
    showError("editor-error", "Informe o preço (ex.: 49,90).");
    return;
  }
  if (!/^https?:\/\//.test(d.cta.href)) {
    showError("editor-error", "Informe o link de checkout completo, começando com https://");
    return;
  }
  if (!d.cta.text) d.cta.text = "Comprar";
  if (!d.id) d.id = `${slugify(`${d.title} ${d.subtitle}`)}`;
  if (!d.image.alt) d.image.alt = `${d.title} ${d.subtitle}`.trim();

  if (d.__pendingImage) {
    const pending = d.__pendingImage;
    delete d.__pendingImage;
    state.pendingImages[pending.name] = {
      dataUrl: pending.dataUrl,
      width: pending.width,
      height: pending.height,
    };
  }

  if (state.editingIndex >= 0) {
    state.products[state.editingIndex] = d;
  } else {
    state.products.push(d);
  }
  markDirty();
  renderList();
  closeEditor();
  toast("Produto salvo. Clique em “Publicar no site” para colocar no ar.");
};

/* ---------------------------- Upload de imagem --------------------------- */

const processImageFile = async (file) => {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, ADMIN.maxImageSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  let dataUrl = canvas.toDataURL("image/webp", 0.85);
  let ext = "webp";
  if (!dataUrl.startsWith("data:image/webp")) {
    dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    ext = "jpg";
  }
  return { dataUrl, width, height, ext };
};

const handleImageUpload = async (file) => {
  if (!file || !file.type.startsWith("image/")) return;
  try {
    const processed = await processImageFile(file);
    readForm();
    const name = `${slugify(`${state.draft.title} ${state.draft.subtitle}`)}-${Date.now().toString(36)}.${processed.ext}`;
    state.draft.__pendingImage = { name, ...processed };
    state.draft.image = {
      src: `./${ADMIN.assetsDir}/${name}`,
      alt: state.draft.image.alt || "",
      width: processed.width,
      height: processed.height,
    };
    $("editor-image-thumb").src = processed.dataUrl;
    renderPreview();
    toast("Imagem pronta. Ela sobe para o site quando você publicar.");
  } catch (error) {
    showError("editor-error", "Não foi possível processar essa imagem. Tente outro arquivo.");
  }
};

/* ------------------------------- Publicação ------------------------------ */

const collectUsedPendingImages = () => {
  const used = {};
  state.products.forEach((product) => {
    const name = (product.image && product.image.src ? product.image.src : "").split("/").pop();
    if (name && state.pendingImages[name]) {
      used[name] = state.pendingImages[name];
    }
  });
  return used;
};

const publish = async () => {
  const overlay = $("publish-overlay");
  const spinner = $("publish-spinner");
  const title = $("publish-title");
  const message = $("publish-message");
  const closeBtn = $("btn-publish-close");

  overlay.hidden = false;
  spinner.className = "overlay__spinner";
  closeBtn.hidden = true;
  title.textContent = "Publicando…";
  message.textContent = "Enviando alterações para o site.";

  try {
    const pending = collectUsedPendingImages();
    const images = Object.keys(pending).map((name) => ({
      name,
      base64: pending[name].dataUrl.split(",")[1],
    }));
    if (images.length) {
      message.textContent = `Enviando ${images.length} imagem${images.length > 1 ? "ns" : ""} e a lista de produtos…`;
    }
    await api("/api/publish", { products: state.products, images });

    state.pendingImages = {};
    markClean();
    renderList();
    spinner.className = "overlay__spinner is-done";
    title.textContent = "Publicado com sucesso!";
    message.textContent = "O site atualiza em 1–2 minutos. Pode fechar esta janela.";
  } catch (error) {
    spinner.className = "overlay__spinner is-done is-error";
    title.textContent = "Não foi possível publicar";
    message.textContent = `${error.message || error} Suas alterações continuam salvas aqui no painel — tente de novo.`;
  }
  closeBtn.hidden = false;
};

/* ----------------------------- Autenticação ------------------------------ */

const openPanel = async () => {
  await loadProducts();
  showView("panel");
  restoreDraftIfAny();
  $("dirty-status").hidden = !state.dirty;
  renderList();
};

const handleLogin = async (event) => {
  event.preventDefault();
  const password = $("login-password").value;
  if (!password) return;
  const submit = $("login-submit");
  submit.disabled = true;
  submit.textContent = "Verificando…";
  showError("login-error", "");
  try {
    state.password = password;
    await openPanel();
    localStorage.removeItem("ltg_admin_gh"); // limpa configuração do fluxo antigo por token
    $("login-password").value = "";
  } catch (error) {
    state.password = null;
    showView("login");
    showError(
      "login-error",
      error.status === 401 ? "Senha incorreta. Tente novamente." : error.message,
    );
  } finally {
    submit.disabled = false;
    submit.textContent = "Entrar no painel";
  }
};

const logout = () => {
  state.password = null;
  state.products = [];
  state.pendingImages = {};
  state.dirty = false;
  showView("login");
};

/* ------------------------------- Eventos --------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  showView("login");

  $("login-form").addEventListener("submit", handleLogin);

  $("btn-toggle-password").addEventListener("click", () => {
    const input = $("login-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("btn-toggle-password").innerHTML = show ? ICONS.eyeOff : ICONS.eye;
    input.focus();
  });

  /* Menu do topo */
  $("btn-menu").addEventListener("click", (event) => {
    event.stopPropagation();
    const list = $("menu-list");
    list.hidden = !list.hidden;
    $("btn-menu").setAttribute("aria-expanded", String(!list.hidden));
  });
  document.addEventListener("click", () => {
    $("menu-list").hidden = true;
  });

  $("btn-reload").addEventListener("click", async () => {
    $("menu-list").hidden = true;
    if (
      state.dirty &&
      !confirm("Recarregar do site descarta as alterações não publicadas. Continuar?")
    ) {
      return;
    }
    try {
      await loadProducts();
      state.pendingImages = {};
      markClean();
      renderList();
      toast("Produtos recarregados do site.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("btn-logout").addEventListener("click", () => {
    $("menu-list").hidden = true;
    logout();
  });

  $("btn-add").addEventListener("click", () => openEditor(-1));

  $("btn-publish").addEventListener("click", () => {
    if (!state.dirty) {
      toast("Nenhuma alteração pendente para publicar.");
      return;
    }
    publish();
  });

  $("btn-publish-close").addEventListener("click", () => {
    $("publish-overlay").hidden = true;
  });

  /* Ações da lista (delegação) */
  $("product-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const index = Number(button.dataset.index);
    const action = button.dataset.action;

    if (action === "edit") {
      openEditor(index);
    } else if (action === "up" && index > 0) {
      const [item] = state.products.splice(index, 1);
      state.products.splice(index - 1, 0, item);
      markDirty();
      renderList();
    } else if (action === "down" && index < state.products.length - 1) {
      const [item] = state.products.splice(index, 1);
      state.products.splice(index + 1, 0, item);
      markDirty();
      renderList();
    } else if (action === "dup") {
      const copy = deepCopy(state.products[index]);
      copy.id = `${copy.id || "produto"}-copia`;
      state.products.splice(index + 1, 0, copy);
      markDirty();
      renderList();
      toast("Produto duplicado.");
    } else if (action === "del") {
      const product = state.products[index];
      const name = `${product.title || "produto"} ${product.subtitle || ""}`.trim();
      if (confirm(`Excluir “${name}”? A exclusão só vai ao ar depois de publicar.`)) {
        state.products.splice(index, 1);
        markDirty();
        renderList();
        toast("Produto excluído. Publique para atualizar o site.");
      }
    }
  });

  /* Editor */
  document.querySelectorAll("[data-close-editor]").forEach((node) => {
    node.addEventListener("click", () => {
      closeEditor();
    });
  });

  $("editor-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveProduct();
  });

  $("editor-form").addEventListener("input", (event) => {
    if (!state.draft) return;
    if (event.target.type === "color") {
      const code = event.target.parentElement.querySelector("code");
      if (code) code.textContent = event.target.value;
    }
    readForm();
    renderPreview();
  });

  $("dots-list").addEventListener("click", (event) => {
    const remove = event.target.closest("button[data-dot-remove]");
    if (!remove || !state.draft) return;
    state.draft.shade.dots.splice(Number(remove.dataset.dotRemove), 1);
    renderDots();
    renderPreview();
  });

  $("btn-add-dot").addEventListener("click", () => {
    if (!state.draft) return;
    if ((state.draft.shade.dots || []).length >= 3) return;
    state.draft.shade.dots.push("#b75f45");
    renderDots();
    renderPreview();
  });

  $("f-image").addEventListener("change", (event) => {
    handleImageUpload(event.target.files[0]);
    event.target.value = "";
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("editor").hidden) {
      closeEditor();
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
});
