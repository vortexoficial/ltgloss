document.documentElement.classList.add("js");

const faqItems = [...document.querySelectorAll(".faq__list details")];
const lazyVideos = [...document.querySelectorAll("[data-lazy-video]")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const loadVideo = (video) => {
  video.querySelectorAll("source[data-src]").forEach((source) => {
    source.src = source.dataset.src;
    delete source.dataset.src;
  });
  video.load();
  if (!reduceMotion.matches) {
    video.play().catch(() => {});
  }
};

if ("IntersectionObserver" in window) {
  const videoObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          loadVideo(entry.target);
          videoObserver.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "400px 0px" },
  );

  lazyVideos.forEach((video) => videoObserver.observe(video));
} else {
  lazyVideos.forEach(loadVideo);
}

let observeReveal = (element) => element.classList.add("is-visible");

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );

  observeReveal = (element) => revealObserver.observe(element);
}

document.querySelectorAll(".reveal").forEach((element) => observeReveal(element));

const setFaqState = (item, shouldOpen) => {
  if (reduceMotion.matches || !item.animate) {
    item.open = shouldOpen;
    return;
  }

  const summary = item.querySelector("summary");
  const startHeight = item.offsetHeight;

  if (shouldOpen) {
    item.open = true;
  }

  const endHeight = shouldOpen ? item.scrollHeight : summary.offsetHeight;
  item.dataset.animating = "true";

  const animation = item.animate(
    { height: [`${startHeight}px`, `${endHeight}px`] },
    { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );

  animation.addEventListener(
    "finish",
    () => {
      item.open = shouldOpen;
      delete item.dataset.animating;
    },
    { once: true },
  );
};

const offersGrid = document.querySelector("[data-offers-grid]");

const hexToRgba = (hex, alpha) => {
  const value = String(hex || "").replace("#", "");
  const expanded = value.length === 3 ? value.replace(/./g, "$&$&") : value;
  const int = parseInt(expanded, 16);
  if (Number.isNaN(int) || expanded.length !== 6) {
    return `rgba(183, 95, 69, ${alpha})`;
  }
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const buildOfferCard = (product, index) => {
  const colors = product.colors || {};
  const cta = product.cta || {};
  const image = product.image || {};
  const shade = product.shade || {};
  const accent = colors.accent || "#b75f45";

  const card = el("article", "offer-card is-dyn reveal");
  if (product.featured) {
    card.classList.add("is-featured");
  }
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
  img.src = image.src || "";
  img.alt = image.alt || `${product.title || ""} ${product.subtitle || ""}`.trim();
  if (image.width) img.width = image.width;
  if (image.height) img.height = image.height;
  img.loading = "lazy";
  img.decoding = "async";
  media.append(img);

  const number = el("span", "offer-card__number", String(index + 1).padStart(2, "0"));
  number.setAttribute("aria-hidden", "true");
  media.append(number);

  if (product.tag) {
    media.append(el("span", "offer-card__tag", product.tag));
  }

  const content = el("div", "offer-card__content");

  if (product.promo) {
    content.append(el("span", "offer-card__promo", product.promo));
  }

  const dots = (Array.isArray(shade.dots) ? shade.dots : []).filter(Boolean);
  if (shade.label || dots.length) {
    const shadeRow = el("div", "offer-card__shade");
    if (dots.length) {
      const stack = el("span", "shade-stack");
      stack.setAttribute("aria-hidden", "true");
      dots.forEach((color) => {
        const dot = el("span", "shade-dot");
        dot.style.background = color;
        stack.append(dot);
      });
      shadeRow.append(stack);
    }
    if (shade.label) {
      shadeRow.append(el("span", "", shade.label));
    }
    content.append(shadeRow);
  }

  const heading = el("h3", "", product.title ? `${product.title} ` : "");
  if (product.subtitle) {
    heading.append(el("em", "", product.subtitle));
  }
  content.append(heading);

  if (product.description) {
    content.append(el("p", "", product.description));
  }

  const price = el("div", "offer-card__price");
  if (product.oldPrice) {
    price.classList.add("offer-card__price--promo");
    price.append(el("span", "offer-card__old-price", product.oldPrice));
  }
  const amount = document.createElement("strong");
  amount.append(el("small", "", "R$"), document.createTextNode(` ${product.price || ""}`));
  price.append(amount);
  if (product.installments) {
    price.append(el("span", "", product.installments));
  }
  content.append(price);

  const link = el("a", "offer-card__cta", `${cta.text || "Comprar"} `);
  link.href = cta.href || "#ofertas";
  const arrow = el("span", "", "↗");
  arrow.setAttribute("aria-hidden", "true");
  link.append(arrow);
  content.append(link);

  card.append(media, content);
  return card;
};

const renderOffers = (products) => {
  offersGrid.style.setProperty("--offers-cols", String(Math.min(products.length, 5)));
  offersGrid.textContent = "";
  products.forEach((product, index) => {
    const card = buildOfferCard(product, index);
    offersGrid.append(card);
    observeReveal(card);
  });
};

if (offersGrid) {
  fetch("./products.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then((data) => {
      const products = Array.isArray(data && data.products) ? data.products : [];
      if (products.length) {
        renderOffers(products);
      }
    })
    .catch(() => {});
}

faqItems.forEach((item) => {
  item.querySelector("summary").addEventListener("click", (event) => {
    event.preventDefault();

    if (item.dataset.animating === "true") {
      return;
    }

    const shouldOpen = !item.open;

    faqItems.forEach((otherItem) => {
      if (otherItem !== item && otherItem.open && otherItem.dataset.animating !== "true") {
        setFaqState(otherItem, false);
      }
    });

    setFaqState(item, shouldOpen);
  });
});
