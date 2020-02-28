import { Node } from "unist";
import path from "path";
import { mkdirSync, writeFileSync } from "fs";
import crypto from "crypto";
import AWS from "aws-sdk";
import { LexiconNameList, VoiceId } from "aws-sdk/clients/polly";
const AwsConfig = AWS.config;
import { AWSRegion } from "aws-sdk/clients/cur";
import { Actions, Cache, Reporter } from "gatsby";
import extractSpeechOutputBlocks, {
  SpeechOutputBlock
} from "./internals/utils/extractSpeechOutputBlocks";

const getSpeechMarksCacheKey = (speechOutputId: string) =>
  `${speechOutputId}.json`;
const getAudioCacheKey = (speechOutputId: string) => `${speechOutputId}.mp3`;
const getRelativeAudioPath = (speechOutputId: string) =>
  `/tts/${speechOutputId}.mp3`;

const getHash = (text: string) =>
  crypto
    .createHash("md5")
    .update(text)
    .digest("hex");

const hasTextChanged = (speechMarksJson: any, freshText: string) => {
  const textHashInFile = speechMarksJson.textHash;
  return getHash(freshText) !== textHashInFile;
};

const generateTtsFiles = async (
  pluginOptions: PluginOptions,
  text: string,
  cache: Cache,
  reporter: Reporter,
  speechOutputId: string
) => {
  // TODO: move AWS and Polly initialization out of this loop but only initialize if actually some text has changed
  AwsConfig.update({
    region: pluginOptions.awsRegion,
    ...(pluginOptions.awsCredentials && {
      credentials: {
        accessKeyId: pluginOptions.awsCredentials.accessKeyId,
        secretAccessKey: pluginOptions.awsCredentials.secretAccessKey
      }
    })
  });
  const Polly = new AWS.Polly({ apiVersion: "2016-06-10" });

  let ssmlTagsBeforeText = "";
  let ssmlTagsAfterText = "";
  if (pluginOptions.defaultSsmlTags) {
    if (pluginOptions.defaultSsmlTags.indexOf("$SPEECH_OUTPUT_TEXT") === -1) {
      throw new Error(
        "If the 'defaultSsmlTags' option is defined it must contain the '$SPEECH_OUTPUT_TEXT' variable (see README file)."
      );
    }
    const matches = pluginOptions.defaultSsmlTags.match(
      /(.*)\$SPEECH_OUTPUT_TEXT(.*)/
    );
    if (!!matches) {
      ssmlTagsBeforeText = matches[1];
      ssmlTagsAfterText = matches[2];
    } else {
      throw new Error(
        "Invalid 'defaultSsmlTags' option defined. Check README file for more information about the option."
      );
    }
  }
  const textWithSsmlTags = `<speak>${ssmlTagsBeforeText}${text}${ssmlTagsAfterText}</speak>`;

  const pollyBaseConfiguration = {
    VoiceId: pluginOptions.defaultVoiceId,
    LexiconNames: pluginOptions.lexiconNames,
    TextType: "ssml",
    Text: textWithSsmlTags
  };

  reporter.info(
    `(Re-)generating mp3 for SpeechOutput with ID: ${speechOutputId}`
  );
  const mp3Data = await Polly.synthesizeSpeech({
    OutputFormat: "mp3",
    ...pollyBaseConfiguration
  }).promise();
  if (mp3Data.AudioStream instanceof Buffer) {
    cache.cache.set(getAudioCacheKey(speechOutputId), mp3Data.AudioStream);
  }

  reporter.info(
    `(Re-)generating speech marks for SpeechOutput with ID: ${speechOutputId}`
  );
  const jsonData = await Polly.synthesizeSpeech({
    OutputFormat: "json",
    SpeechMarkTypes: ["word"],
    ...pollyBaseConfiguration
  }).promise();
  if (jsonData.AudioStream instanceof Buffer) {
    const speechMarks = jsonData.AudioStream.toString();
    const speechMarksJson = JSON.parse(
      `[${speechMarks.replace(/\}\n\{/g, "},{")}]`
    );
    const json = {
      textHash: getHash(text),
      speechMarks: speechMarksJson
    };
    cache.cache.set(getSpeechMarksCacheKey(speechOutputId), json);
  }
};

const generateFiles = async (
  speechOutputBlocks: SpeechOutputBlock[],
  pluginOptions: PluginOptions,
  cache: Cache,
  reporter: Reporter
) => {
  for (let i = 0; i < speechOutputBlocks.length; i++) {
    const speechOutputBlock = speechOutputBlocks[i];

    const speechMarks = await cache.cache.get(
      getSpeechMarksCacheKey(speechOutputBlock.id)
    );
    const audio = await cache.cache.get(getAudioCacheKey(speechOutputBlock.id));

    const filesAlreadyExist = speechMarks && audio;
    if (
      !filesAlreadyExist ||
      hasTextChanged(speechMarks, speechOutputBlock.text)
    ) {
      await generateTtsFiles(
        pluginOptions,
        speechOutputBlock.text,
        cache,
        reporter,
        speechOutputBlock.id
      );
    }

    const eventuallyRegeneratedAudio = await cache.cache.get(
      getAudioCacheKey(speechOutputBlock.id)
    );
    const audioFilePath = `./public${getRelativeAudioPath(
      speechOutputBlock.id
    )}`;
    mkdirSync(path.dirname(audioFilePath), { recursive: true });
    writeFileSync(audioFilePath, eventuallyRegeneratedAudio);
  }
};

const createNodesForSpeechOutputBlocks = async (
  speechOutputBlocks: SpeechOutputBlock[],
  parameters: Parameters
) => {
  await Promise.all(
    speechOutputBlocks.map(async (speechOutputBlock: SpeechOutputBlock) => {
      const speechMarks = (
        await parameters.cache.cache.get(
          getSpeechMarksCacheKey(speechOutputBlock.id)
        )
      ).speechMarks;
      await parameters.actions.createNode({
        speechOutputId: speechOutputBlock.id,
        relativeAudioFilePath: getRelativeAudioPath(speechOutputBlock.id),
        speechMarks,

        id: parameters.createNodeId(speechOutputBlock.id),
        children: [],
        internal: {
          contentDigest: parameters.createContentDigest(speechOutputBlock.text),
          type: "SpeechOutput"
        }
      });
    })
  );
};

interface Parameters {
  markdownAST: Node;
  cache: Cache;
  actions: Actions;
  createNodeId: (input: string) => string;
  createContentDigest: (input: string | object) => string;
  reporter: Reporter;
}

interface PluginOptions {
  awsRegion: AWSRegion;
  defaultVoiceId: VoiceId;
  awsCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  defaultSsmlTags?: string;
  lexiconNames?: LexiconNameList;
}

module.exports = async (
  parameters: Parameters,
  pluginOptions: PluginOptions
) => {
  const speechOutputBlocks = extractSpeechOutputBlocks(parameters.markdownAST);

  if (speechOutputBlocks.length > 0) {
    await generateFiles(
      speechOutputBlocks,
      pluginOptions,
      parameters.cache,
      parameters.reporter
    );
  }

  // TODO currently, nodes are only created if gatsby-plugin-mdx runs and does not get MDX from cache. If it gets it from cache because there are no changes in MDX files, we don't have any speech output nodes as a result!
  // TODO: create a gatsby-node.js and check if there are cached speech outputs and if yes, create nodes from there.
  await createNodesForSpeechOutputBlocks(speechOutputBlocks, parameters);

  return parameters.markdownAST;
};

// TODO: make sure if a certain text is no longer existing, related files are deleted as well!
