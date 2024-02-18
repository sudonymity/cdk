#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { WebsiteStack } from "../lib/website-stack";
import "dotenv/config";

const app = new cdk.App();

new WebsiteStack(app, "WebsiteStack-Prod", {
  domainName: process.env.DOMAIN_NAME || "",
  isProd: true,
  env: {
    account: process.env.CDK_ACCOUNT,
  },
});

new WebsiteStack(app, "WebsiteStack-Dev", {
  domainName: process.env.DOMAIN_NAME || "",
  isProd: false,
  siteSubDomain: "dev",
  env: {
    account: process.env.CDK_ACCOUNT,
  },
});
