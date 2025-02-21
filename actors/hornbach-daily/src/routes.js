const Apify = require("apify");
const {
  toProduct,
  uploadToS3,
  s3FileName
} = require("@hlidac-shopu/actors-common/product.js");
const { LABELS, API_URL, PRICE_HEADER } = require("./const");
const tools = require("./tools");

const {
  utils: { log, requestAsBrowser }
} = Apify;

// Create router
const createRouter = globalContext => {
  return async function (routeName, requestContext) {
    const route = module.exports[routeName];
    if (!route) throw new Error(`No route for name: ${routeName}`);
    log.debug(`Invoking route: ${routeName}`);
    return route(requestContext, globalContext);
  };
};

const SITE = async ({ body, crawler }) => {
  log.info("START with main page");
  const links = tools.siteMapToLinks(body);
  for (const link of links) {
    const id = tools.getCategoryId(link);
    await crawler.requestQueue.addRequest(
      {
        url: API_URL(id),
        userData: {
          label: LABELS.CATEGORY,
          categoryId: id,
          link
        }
      },
      { forefront: true }
    );
  }
};

const CATEGORY = async ({ request, json, crawler }) => {
  const { s3 } = global;
  const { pageNumber, pageCount, articles } = json;
  if (pageNumber === 1) {
    const {
      userData: { categoryId }
    } = request;
    for (let i = 2; i <= pageCount; i++) {
      await crawler.requestQueue.addRequest({
        url: API_URL(categoryId, i),
        userData: {
          label: LABELS.CATEGORY,
          categoryId,
          page: i
        }
      });
    }
  }
  if (articles.length > 0) {
    const requests = [];
    const codes = articles.map(a => a.articleCode);
    const { statusCode, body } = await requestAsBrowser({
      url: "https://www.hornbach.cz/mvc/article/displaystates-and-prices.json",
      method: "POST",
      json: true,
      useHttp2: true,
      headers: PRICE_HEADER,
      payload: JSON.stringify(codes)
    });
    for (const article of articles) {
      const result = {
        itemId: article.articleCode,
        itemUrl: `https://www.hornbach.cz${article.localizedExternalArticleLink}`,
        itemName: article.title,
        currency: article.allPrices.displayPrice.currency,
        img: article.imageUrl,
        currentPrice: parseFloat(article.allPrices.displayPrice.price),
        originalPrice: null,
        discounted: false,
        category: tools.getCategories(article.categoryPath)
      };
      const price = body.filter(p => p.articleCode === article.articleCode);
      if (price) {
        const { allPrices } = price[0];
        const { displayPrice, guidingPrice } = allPrices;
        if (guidingPrice) {
          result.currentPrice = parseFloat(displayPrice.price);
          result.discounted = true;
          result.originalPrice = parseFloat(guidingPrice.price);
        }
      }
      requests.push(
        Apify.pushData(result),
        uploadToS3(
          s3,
          "hornbach.cz",
          await s3FileName(result),
          "jsonld",
          toProduct(
            {
              ...result,
              inStock: true
            },
            { priceCurrency: result.currency }
          )
        )
      );
    }
    await Promise.all(requests);
  }
};

module.exports = {
  createRouter,
  SITE,
  CATEGORY
};
