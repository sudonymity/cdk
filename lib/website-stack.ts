import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cloudfront_origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

interface BaseWebsiteStackProps extends StackProps {
  domainName: string;
}

interface ProdWebsiteStackProps extends BaseWebsiteStackProps {
  isProd: true;
}

interface NonProdWebsiteStackProps extends BaseWebsiteStackProps {
  isProd: false;
  siteSubDomain: string; // Required for non-prod environments
}

export type WebsiteStackProps =
  | ProdWebsiteStackProps
  | NonProdWebsiteStackProps;

/**
 * The WebsiteStack class creates the necessary AWS infrastructure to host a static website on S3, served via CloudFront,
 * and configured with DNS records in Route 53. It supports flexible deployment environments, distinguishing between
 * production and non-production setups.
 *
 * In production, the stack is designed to handle both the root domain (`domainName`) and its `www` subdomain (`www.domainName`),
 * ensuring the website is accessible through both addresses. This is achieved by configuring an ACM certificate to cover
 * both the root domain and its `www` subdomain, and setting up DNS records to point both domains to the CloudFront distribution.
 * This setup enhances user accessibility and SEO by consolidating domain access paths.
 *
 * For non-production environments, such as development (dev), staging (staging), or testing (test), the stack allows for
 * deployment under a specified subdomain (`siteSubDomain`), facilitating isolated environments for testing and development
 * without affecting the production site. Each non-production environment requires a unique subdomain, ensuring clear
 * separation between different stages of development and production.
 *
 * Key Components:
 * - `siteBucket`: An S3 bucket configured for private access, serving as the storage for the website's static content.
 *   Access is restricted to the CloudFront distribution using an Origin Access Identity (OAI).
 *
 * - `siteDistribution`: A CloudFront distribution that serves the website's content securely over HTTPS. The distribution
 *   is configured with a custom ACM certificate that supports SSL/TLS for the specified domain names. In production,
 *   it includes both the root domain and its `www` subdomain, while for non-production, it covers the specific subdomain.
 *
 * - Route 53 DNS records: For production, A records are created for both the root domain and its `www` subdomain, pointing
 *   to the CloudFront distribution. For non-production environments, an A record is created for the specified subdomain.
 *
 * - ACM Certificate: Requested with SAN for the apex domain in production to ensure SSL/TLS coverage for both `www.domainName`
 *   and `domainName`. For non-production environments, the certificate covers only the specific subdomain.
 *
 * This architecture allows for a unified approach to website deployment across different environments, ensuring secure,
 * scalable, and maintainable infrastructure for hosting static websites on AWS.
 *
 * Usage:
 * For production, initialize the stack with `isProd: true`. This automatically configures the stack for the root domain
 * and its `www` subdomain. For non-production environments, initialize with `isProd: false` and provide a `siteSubDomain`.
 */

export class WebsiteStack extends Stack {
  public readonly siteBucket: s3.Bucket;
  public readonly siteDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebsiteStackProps) {
    super(scope, id, {
      ...props,
      env: {
        account: props.env?.account,
        // Ensuring deployment in "us-east-1" due to the requirement that ACM certificates for CloudFront
        // distributions must be requested in this region. This simplification aligns with AWS best practices
        // for CloudFront and ACM, ensuring seamless SSL/TLS setup.
        region: "us-east-1",
      },
    });

    // Set siteSubDomain to "www" for production, otherwise use provided siteSubDomain
    const siteSubDomain = props.isProd ? "www" : props.siteSubDomain;
    const siteDomain = `${siteSubDomain}.${props.domainName}`;

    // Lookup the hosted zone for DNS configuration
    const zone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: props.domainName,
    });

    // Create an OAI for restricting access to the S3 bucket from CloudFront
    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(
      this,
      `cloudfront-OAI`,
      {
        comment: `OAI for ${siteDomain}`,
      }
    );

    // Setup private S3 bucket for website content, with access limited to CloudFront OAI
    this.siteBucket = new s3.Bucket(this, `SiteBucket`, {
      bucketName: siteDomain,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Grant CloudFront access to the S3 bucket
    this.siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [this.siteBucket.arnForObjects("*")],
        principals: [
          new iam.CanonicalUserPrincipal(
            cloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    );

    // Request a certificate with SAN for the apex domain in production environments
    // This ensures SSL/TLS coverage for both www.domainName and domainName
    const certificate = new acm.Certificate(this, `SiteCertificate`, {
      domainName: siteDomain,
      validation: acm.CertificateValidation.fromDns(zone),
      // Include the apex domain as SAN for production
      ...(props.isProd && { subjectAlternativeNames: [props.domainName] }),
    });

    // Create a CloudFront distribution for serving website content securely over HTTPS
    // Include apex domain for production to support direct access alongside www subdomain
    this.siteDistribution = new cloudfront.Distribution(
      this,
      `SiteDistribution`,
      {
        certificate: certificate,
        domainNames: [
          siteDomain,
          // Include the apex domain for production
          ...(props.isProd ? [props.domainName] : []),
        ],
        defaultRootObject: "index.html",
        defaultBehavior: {
          origin: new cloudfront_origins.S3Origin(this.siteBucket, {
            originAccessIdentity: cloudfrontOAI,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        errorResponses: [
          {
            httpStatus: 404,
            ttl: Duration.seconds(0),
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
          },
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(0),
          },
        ],
      }
    );

    // Route 53 A record for the siteDomain points to the CloudFront distribution
    new route53.ARecord(this, "SiteAliasRecord", {
      zone,
      recordName: siteDomain,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.siteDistribution)
      ),
    });

    // Additionally, create an A record for the apex domain in production environments
    // This aligns DNS configuration with supported domains in CloudFront distribution
    if (props.isProd) {
      new route53.ARecord(this, "SiteAliasRecordApex", {
        zone,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.siteDistribution)
        ),
      });
    }

    // Output the site URL, bucket name, and distribution domain name for easy access
    new CfnOutput(this, "Site", { value: "https://" + siteDomain });
    new CfnOutput(this, "Bucket", { value: this.siteBucket.bucketName });
    new CfnOutput(this, "DistributionDomainName", {
      value: this.siteDistribution.distributionDomainName,
    });
  }
}
