import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { returnDalleImage } from "./dalle";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { Readable } from "stream";
import { createMongoDBConnection } from "./shared/mongodbConfig";
import { logger } from "./shared/pinoLogger";
import { VisionResponseObjectInterface } from "./analyzeImage";
import { uploadImageToBlobStorage } from "./shared/uploadImageToBlobStorage";
import { insertDalleAsset } from "./shared/insertDalleAsset";

export interface dalleAssetInterface {
  code: string;
  prompt: string;
  orientation: "square" | "horizontal" | "vertical";
  isTransparent: boolean;
  description: string;
  width?: number;
  height?: number;
  revisedPrompt?: string;
  tags: string[];
  url?: string;
  scene?: VisionResponseObjectInterface
}

export async function createDalleAsset(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const AZURE_STORAGE_CONNECTION_STRING =
    process.env.AZURE_STORAGE_CONNECTION_STRING;

  const blobServiceClient = BlobServiceClient.fromConnectionString(
    AZURE_STORAGE_CONNECTION_STRING
  );

  const containerClient = blobServiceClient.getContainerClient("motion-ai");
  const textBody = await request.text();
  const parsedBody: dalleAssetInterface[] = JSON.parse(textBody);
  const db = await createMongoDBConnection();
  const dalleAssets = db.collection<dalleAssetInterface>("dalleAssets");
  let createdAssets: dalleAssetInterface[] = [];

  for (const receivedObject of parsedBody) {
    if (receivedObject.prompt.length < 3 || !["square", "horizontal", "vertical"].includes(receivedObject.orientation)) {
      logger.error(new Error("Invalid input"));
      return { status: 400 };
    }
  }

  try {
    for await (const [indexAsset, assetPayload] of parsedBody.entries()) {
      const newImage = await returnDalleImage(
        assetPayload.prompt,
        assetPayload.orientation
      );
      const assetCode = uuidv4();
      const blobName = `${assetCode}.png`;
      const imageBuffer = await axios.get(newImage.url, {
        responseType: "arraybuffer",
      });
      const imageStream = Readable.from(Buffer.from(imageBuffer.data));
      const url = await uploadImageToBlobStorage(containerClient, imageStream, blobName);

      const newAssetPayload: dalleAssetInterface = {
        prompt: parsedBody[indexAsset].prompt,
        orientation: parsedBody[indexAsset].orientation,
        isTransparent: parsedBody[indexAsset].isTransparent,
        code: assetCode,
        width: parsedBody[indexAsset].orientation === "horizontal" ? 1792 : 1024,
        height: parsedBody[indexAsset].orientation === "vertical" ? 1792 : 1024,
        revisedPrompt: newImage.revisedPrompt,
        description: parsedBody[indexAsset].description,
        tags: parsedBody[indexAsset].tags,
        url,
      };

      await insertDalleAsset(dalleAssets, newAssetPayload);
      createdAssets.push(newAssetPayload);
    }

    return { jsonBody: createdAssets };
  } catch (error) {
    console.error("Error downloading or uploading asset: ", error);
    return { body: error };
  }
}

async function deleteDalleAsset(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const textBody = await request.text();
  const parsedBody: { code: string } = JSON.parse(textBody);
  const db = await createMongoDBConnection();
  const dalleAssets = db.collection("dalleAssets");

  const AZURE_STORAGE_CONNECTION_STRING =
    process.env.AZURE_STORAGE_CONNECTION_STRING;

  const blobServiceClient = BlobServiceClient.fromConnectionString(
    AZURE_STORAGE_CONNECTION_STRING
  );
  const containerClient = blobServiceClient.getContainerClient("motion-ai");

  try {
    const deleteDalleAssetResponse = await dalleAssets.deleteOne({
      code: parsedBody.code,
    });
    const blockBlobClient = containerClient.getBlockBlobClient(
      parsedBody.code + ".png"
    );

    await blockBlobClient.delete({ deleteSnapshots: "include" });

    return { jsonBody: deleteDalleAssetResponse };
  } catch (error) {
    console.error("Error deleting asset: ", error);
    return { body: error };
  }
}

app.http("dalleAsset", {
  methods: ["POST", "DELETE"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    switch (req.method) {
      case "POST":
        return await createDalleAsset(req, context);
      case "DELETE":
        return await deleteDalleAsset(req, context);
    }
  },
});
