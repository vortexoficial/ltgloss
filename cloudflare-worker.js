/* =========================================================================
   Cloudflare Worker · Painel LT Gloss
   Faz a ponte entre o painel (admin.html) e o repositório no GitHub.
   O token do GitHub e o hash da senha ficam como SEGREDOS no Cloudflare:
     - GITHUB_TOKEN   → fine-grained PAT com Contents: Read and write
     - PASSWORD_HASH  → SHA-256 (hex) da senha do painel

   Este arquivo não contém nenhum segredo — é seguro versionar.
========================================================================= */

const OWNER = "vortexoficial";
const REPO = "ltgloss";
const BRANCH = "main";
const DATA_PATH = "products.json";
const ASSETS_DIR = "assets";

const ALLOWED_ORIGINS = [
  "https://ltgloss.com",
  "https://www.ltgloss.com",
  "http://localhost:4173",
];

const MAX_PRODUCTS = 30;
const MAX_IMAGES_PER_PUBLISH = 10;
const MAX_IMAGE_BASE64_LENGTH = 3_000_000; // ~2,2 MB por imagem
const IMAGE_NAME_PATTERN = /^[a-z0-9-]+\.(webp|jpe?g|png)$/;

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  Vary: "Origin",
});

const json = (status, data, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });

const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const timingSafeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const gh = async (env, path, options = {}) => {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ltgloss-painel-worker",
      ...(options.headers || {}),
    },
  });
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

const getFileSha = async (env, path) => {
  try {
    const file = await gh(env, `contents/${path}?ref=${encodeURIComponent(BRANCH)}`);
    return file.sha;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
};

/* Base64 UTF-8 sem depender de Buffer */
const utf8ToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const base64ToUtf8 = (base64) => {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};

const handleLoad = async (env, origin) => {
  try {
    const file = await gh(env, `contents/${DATA_PATH}?ref=${encodeURIComponent(BRANCH)}`);
    const data = JSON.parse(base64ToUtf8(file.content));
    return json(200, { products: Array.isArray(data.products) ? data.products : [] }, origin);
  } catch (error) {
    if (error.status === 404) {
      return json(200, { products: [] }, origin);
    }
    throw error;
  }
};

const handlePublish = async (env, origin, body) => {
  const products = body.products;
  const images = Array.isArray(body.images) ? body.images : [];

  if (!Array.isArray(products) || products.length > MAX_PRODUCTS) {
    return json(400, { message: "Lista de produtos inválida." }, origin);
  }
  if (images.length > MAX_IMAGES_PER_PUBLISH) {
    return json(400, { message: "Muitas imagens em uma única publicação." }, origin);
  }
  for (const image of images) {
    if (
      !image ||
      !IMAGE_NAME_PATTERN.test(image.name || "") ||
      typeof image.base64 !== "string" ||
      !image.base64.length ||
      image.base64.length > MAX_IMAGE_BASE64_LENGTH
    ) {
      return json(400, { message: `Imagem inválida: ${image && image.name ? image.name : "sem nome"}.` }, origin);
    }
  }

  for (const image of images) {
    const path = `${ASSETS_DIR}/${image.name}`;
    const sha = await getFileSha(env, path);
    await gh(env, `contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Painel: adiciona imagem ${image.name}`,
        content: image.base64,
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
  }

  const sha = await getFileSha(env, DATA_PATH);
  const payload = { updatedAt: new Date().toISOString(), products };
  await gh(env, `contents/${DATA_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "Painel: atualiza produtos e ofertas",
      content: utf8ToBase64(`${JSON.stringify(payload, null, 2)}\n`),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  return json(200, { ok: true }, origin);
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json(405, { message: "Método não permitido." }, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return json(400, { message: "Corpo da requisição inválido." }, origin);
    }

    if (!env.GITHUB_TOKEN || !env.PASSWORD_HASH) {
      return json(500, { message: "Worker sem configuração: defina os segredos GITHUB_TOKEN e PASSWORD_HASH." }, origin);
    }

    const hash = await sha256Hex(String(body.password || ""));
    if (!timingSafeEqual(hash, String(env.PASSWORD_HASH).toLowerCase())) {
      return json(401, { message: "Senha incorreta." }, origin);
    }

    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/load") {
        return await handleLoad(env, origin);
      }
      if (pathname === "/api/publish") {
        return await handlePublish(env, origin, body);
      }
      return json(404, { message: "Rota não encontrada." }, origin);
    } catch (error) {
      return json(502, { message: error.message || "Falha ao falar com o GitHub." }, origin);
    }
  },
};
