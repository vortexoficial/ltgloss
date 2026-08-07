"use strict";

/* =========================================================================
   Painel administrativo · LT Gloss
   - Login por senha (PBKDF2; nenhuma senha fica em texto no código)
   - Token do GitHub criptografado (AES-GCM) com a chave derivada da senha
   - Edita products.json e publica direto no repositório (GitHub Pages)
========================================================================= */

const ADMIN = {
  verifierHex: "15e17b8dd36d28f9061d5b349dac30ce42179416bde17ba23cec9f7fb82e13dd",
  saltVerify: "ltgloss::verify::v1",
  saltKey: "ltgloss::key::v1",
  iterations: 310000,
  storageGh: "ltg_admin_gh",
  storageDraft: "ltg_admin_draft",
  defaults: { owner: "vortexoficial", repo: "ltgloss", branch: "main" },
  dataPath: "products.json",
  assetsDir: "assets",
  maxImageSize: 1200,
};

const state = {
  key: null, // CryptoKey AES derivada da senha
  gh: null, // { owner, repo, branch, token }
  products: [],
  dirty: false,
  editingIndex: -1,
  draft: null,
  pendingImages: {}, // nome do arquivo -> { dataUrl, width, height }
};

const $ = (id) => document.getElementById(id);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* ------------------------------ Utilidades ------------------------------ */

const bytesToBase64 = (bytes) => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const base64ToBytes = (base64) => {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const bufToHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

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

/* ------------------------------ Criptografia ---------------------------- */

const pbkdf2 = async (password, salt) => {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: textEncoder.encode(salt), iterations: ADMIN.iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
};

const deriveAesKey = async (password) => {
  const bits = await pbkdf2(password, ADMIN.saltKey);
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};

const encryptText = async (key, text) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(text));
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(cipher)) };
};

const decryptText = async (key, payload) => {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.ct),
  );
  return textDecoder.decode(plain);
};

/* ------------------------------ GitHub API ------------------------------ */

const gh = async (path, options = {}) => {
  const response = await fetch(
    `https://api.github.com/repos/${state.gh.owner}/${state.gh.repo}/${path}`,
    {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${state.gh.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    },
  );
  if (!response.ok) {
    let message = "";
    try {
      message = (await response.json()).message || "";
    } catch (error) {
      /* corpo vazio */
    }
    const err = new Error(message || `Erro ${response.status} na API do GitHub.`);
    err.status = response.status;
    throw err;
  }
  return response.status === 204 ? null : response.json();
};

const fetchRemoteSha = async () => {
  try {
    const file = await gh(`contents/${ADMIN.dataPath}?ref=${encodeURIComponent(state.gh.branch)}`);
    return file.sha;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
};

/* ------------------------- Carregar / salvar dados ---------------------- */

const loadProducts = async () => {
  try {
    const file = await gh(`contents/${ADMIN.dataPath}?ref=${encodeURIComponent(state.gh.branch)}`);
    const data = JSON.parse(textDecoder.decode(base64ToBytes(file.content)));
    state.products = Array.isArray(data.products) ? data.products : [];
    return;
  } catch (error) {
    if (error.status !== 404) {
      console.warn("Falha ao carregar via API, tentando arquivo local.", error);
    }
  }
  try {
    const response = await fetch(`./${ADMIN.dataPath}`, { cache: "no-cache" });
    const data = await response.json();
    state.products = Array.isArray(data.products) ? data.products : [];
  } catch (error) {
    state.products = [];
    toast("Não foi possível carregar os produtos. Verifique a conexão.");
  }
};

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
  ["view-login", "view-connect", "view-panel"].forEach((id) => {
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
  return src;
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
    const mkBtn = (label, action, title, primary) => {
      const button = el("button", primary ? "btn btn--ghost btn--sm" : "btn btn--icon", label);
      button.type = "button";
      button.dataset.action = action;
      button.dataset.index = String(index);
      button.title = title;
      button.setAttribute("aria-label", title);
      return button;
    };
    actions.append(
      mkBtn("Editar", "edit", `Editar ${product.title || "produto"}`, true),
      mkBtn("↑", "up", "Mover para cima"),
      mkBtn("↓", "down", "Mover para baixo"),
      mkBtn("⧉", "dup", "Duplicar produto"),
      mkBtn("🗑", "del", "Excluir produto"),
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
    const remove = el("button", "", "×");
    remove.type = "button";
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
  $("f-title").focus();
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

  try {
    const images = collectUsedPendingImages();
    const names = Object.keys(images);
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      message.textContent = `Enviando imagem ${i + 1} de ${names.length}…`;
      const path = `${ADMIN.assetsDir}/${name}`;
      let sha;
      try {
        const existing = await gh(`contents/${path}?ref=${encodeURIComponent(state.gh.branch)}`);
        sha = existing.sha;
      } catch (error) {
        sha = undefined;
      }
      await gh(`contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `Painel: adiciona imagem ${name}`,
          content: images[name].dataUrl.split(",")[1],
          branch: state.gh.branch,
          ...(sha ? { sha } : {}),
        }),
      });
    }

    message.textContent = "Atualizando a lista de produtos…";
    const sha = await fetchRemoteSha();
    const payload = { updatedAt: new Date().toISOString(), products: state.products };
    await gh(`contents/${ADMIN.dataPath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: "Painel: atualiza produtos e ofertas",
        content: bytesToBase64(textEncoder.encode(`${JSON.stringify(payload, null, 2)}\n`)),
        branch: state.gh.branch,
        ...(sha ? { sha } : {}),
      }),
    });

    state.pendingImages = {};
    markClean();
    renderList();
    spinner.className = "overlay__spinner is-done";
    title.textContent = "Publicado com sucesso!";
    message.textContent = "O site atualiza em 1–2 minutos. Pode fechar esta janela.";
  } catch (error) {
    spinner.className = "overlay__spinner is-done is-error";
    title.textContent = "Não foi possível publicar";
    message.textContent = `${error.message || error}. Suas alterações continuam salvas aqui no painel — tente de novo.`;
  }
  closeBtn.hidden = false;
};

/* ----------------------------- Autenticação ------------------------------ */

const openPanel = async () => {
  showView("panel");
  $("products-count").textContent = "Carregando produtos…";
  $("product-list").textContent = "";
  await loadProducts();
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
    const hex = bufToHex(await pbkdf2(password, ADMIN.saltVerify));
    if (hex !== ADMIN.verifierHex) {
      showError("login-error", "Senha incorreta. Tente novamente.");
      return;
    }
    state.key = await deriveAesKey(password);
    $("login-password").value = "";

    const stored = localStorage.getItem(ADMIN.storageGh);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const token = await decryptText(state.key, parsed);
        state.gh = {
          owner: parsed.owner || ADMIN.defaults.owner,
          repo: parsed.repo || ADMIN.defaults.repo,
          branch: parsed.branch || ADMIN.defaults.branch,
          token,
        };
        await openPanel();
        return;
      } catch (error) {
        localStorage.removeItem(ADMIN.storageGh);
      }
    }
    $("btn-connect-back").hidden = true;
    showView("connect");
  } finally {
    submit.disabled = false;
    submit.textContent = "Entrar no painel";
  }
};

const handleConnect = async (event) => {
  event.preventDefault();
  const token = $("gh-token").value.trim();
  const owner = $("gh-owner").value.trim();
  const repo = $("gh-repo").value.trim();
  const branch = $("gh-branch").value.trim() || "main";
  const submit = $("connect-submit");
  showError("connect-error", "");

  if (!token || !owner || !repo) {
    showError("connect-error", "Preencha o token, o usuário e o repositório.");
    return;
  }

  submit.disabled = true;
  submit.textContent = "Validando…";
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error("Não foi possível acessar o repositório. Confira o token e os dados.");
    }
    const info = await response.json();
    if (!info.permissions || !info.permissions.push) {
      throw new Error("Este token não tem permissão de escrita. Crie com Contents: Read and write.");
    }
    const encrypted = await encryptText(state.key, token);
    localStorage.setItem(
      ADMIN.storageGh,
      JSON.stringify({ owner, repo, branch, iv: encrypted.iv, ct: encrypted.ct }),
    );
    state.gh = { owner, repo, branch, token };
    $("gh-token").value = "";
    await openPanel();
  } catch (error) {
    showError("connect-error", error.message || "Falha ao validar. Tente novamente.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Validar e salvar";
  }
};

const logout = () => {
  state.key = null;
  state.gh = null;
  state.products = [];
  state.pendingImages = {};
  state.dirty = false;
  showView("login");
};

/* ------------------------------- Eventos --------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  showView("login");

  $("login-form").addEventListener("submit", handleLogin);
  $("connect-form").addEventListener("submit", handleConnect);

  $("btn-toggle-password").addEventListener("click", () => {
    const input = $("login-password");
    input.type = input.type === "password" ? "text" : "password";
    input.focus();
  });

  $("btn-connect-back").addEventListener("click", () => {
    showView("panel");
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
    state.pendingImages = {};
    markClean();
    await loadProducts();
    renderList();
    toast("Produtos recarregados do site.");
  });

  $("btn-settings").addEventListener("click", () => {
    $("menu-list").hidden = true;
    $("gh-owner").value = state.gh ? state.gh.owner : ADMIN.defaults.owner;
    $("gh-repo").value = state.gh ? state.gh.repo : ADMIN.defaults.repo;
    $("gh-branch").value = state.gh ? state.gh.branch : ADMIN.defaults.branch;
    $("btn-connect-back").hidden = false;
    showError("connect-error", "");
    showView("connect");
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
    if (event.target.dataset.dotIndex !== undefined) {
      state.draft.shade.dots[Number(event.target.dataset.dotIndex)] = event.target.value;
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
