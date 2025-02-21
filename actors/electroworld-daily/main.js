const { S3Client } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: "eu-central-1" });
const { uploadToKeboola } = require("@hlidac-shopu/actors-common/keboola.js");
const { CloudFrontClient } = require("@aws-sdk/client-cloudfront");
const {
  invalidateCDN,
  toProduct,
  uploadToS3,
  s3FileName
} = require("@hlidac-shopu/actors-common/product.js");
const rollbar = require("@hlidac-shopu/actors-common/rollbar.js");
const Apify = require("apify");
const { fetchPage, fetchDetail, countProducts } = require("./src/crawler");
const {
  utils: { log }
} = Apify;

let stats = {};
const processedIds = new Set();

Apify.main(async () => {
  rollbar.init();
  const cloudfront = new CloudFrontClient({ region: "eu-central-1" });
  const input = await Apify.getInput();
  const {
    development = false,
    debug = false,
    maxRequestRetries = 3,
    maxConcurrency = 10,
    proxyGroups = ["CZECH_LUMINATI"],
    type = "FULL",
    startUrls = [
      "https://www.electroworld.cz/smart-inteligentni-domacnost",
      "https://www.electroworld.cz/televize-foto-audio-video",
      "https://www.electroworld.cz/mobily-notebooky-tablety-pc-gaming",
      "https://www.electroworld.cz/velke-spotrebice-chladnicky-pracky",
      "https://www.electroworld.cz/male-spotrebice-vysavace-kavovary",
      "https://www.electroworld.cz/zahrada-dum-sport-hobby"
    ],
    detailURLs = [
      "https://www.electroworld.cz/apple-macbook-air-13-m1-256gb-2020-mgn63cz-a-vesmirne-sedy",
      "https://www.electroworld.cz/nine-eagles-galaxy-visitor-3",
      "https://www.electroworld.cz/samsung-galaxy-a52-128-gb-cerna"
    ]
  } = input ?? {};

  stats = (await Apify.getValue("STATS")) || {
    categories: 0,
    pages: 0,
    items: 0,
    itemsSkipped: 0,
    itemsDuplicity: 0,
    failed: 0
  };

  const persistState = async () => {
    await Apify.setValue("STATS", stats).then(() => log.debug("STATS saved!"));
    log.info(JSON.stringify(stats));
  };
  Apify.events.on("persistState", persistState);

  log.info("ACTOR - setUp crawler");
  /** @type {ProxyConfiguration} */
  const proxyConfiguration = await Apify.createProxyConfiguration({
    groups: proxyGroups,
    useApifyProxy: !development
  });
  const dataset = await Apify.openDataset();
  const requestQueue = await Apify.openRequestQueue();
  const crawlContext = {
    requestQueue: requestQueue,
    dataset: dataset,
    stats,
    processedIds,
    s3,
    toProduct,
    uploadToS3,
    s3FileName
  };

  if (type === "FULL") {
    for (let i = 0; i < startUrls.length; i++) {
      await requestQueue.addRequest({ url: startUrls[i] });
    }
  } else if (type === "DETAIL") {
    for (let i = 0; i < detailURLs.length; i++) {
      await requestQueue.addRequest({ url: detailURLs[i] });
    }
  } else if (type === "COUNT") {
    await countProducts(stats);
  } else if (type === "TEST_FULL") {
    await requestQueue.addRequest({
      userData: { label: "nthPage", pageN: 0 },
      url: "https://www.electroworld.cz/smart-televize"
    });
  }

  const crawler = new Apify.CheerioCrawler({
    requestQueue: requestQueue,
    proxyConfiguration: proxyConfiguration,
    maxRequestRetries,
    maxConcurrency,
    handlePageFunction: async context => {
      if (type === "FULL") {
        await fetchPage(context, crawlContext);
      } else if (type === "DETAIL") {
        await fetchDetail(context.$, context.request, dataset);
      }
    }
  });

  log.info("Starting the crawl.");

  await crawler.run();

  console.log("crawler finished");

  await Apify.setValue("STATS", stats).then(() => log.debug("STATS saved!"));
  log.info(JSON.stringify(stats));

  log.info(
    `Found ${crawlContext.stats.categories} subcategory pages and ${crawlContext.stats.pages} ` +
      `product list pages in total; scraped ${crawlContext.stats.items} products.`
  );

  if (!development) {
    await invalidateCDN(cloudfront, "EQYSHWUECAQC9", "electroworld.cz");
    log.info("invalidated Data CDN");
    await uploadToKeboola("electroworld_cz");
    log.info("upload to Keboola finished");
  }
});
