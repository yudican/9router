import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, tokenCompression } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (tokenCompression !== undefined) {
      // null clears the override; object stores the partial override.
      if (tokenCompression === null) {
        updateData.tokenCompression = null;
      } else if (typeof tokenCompression === "object" && !Array.isArray(tokenCompression)) {
        updateData.tokenCompression = sanitizeTcOverride(tokenCompression);
      } else {
        return NextResponse.json({ error: "Invalid tokenCompression" }, { status: 400 });
      }
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// Whitelist allowed override keys to keep storage tidy.
function sanitizeTcOverride(input) {
  const allowed = ["enabled", "losslessOnly", "threshold", "thresholdAbsolute", "keepLastTurns", "protectCodeBlocks", "applyToResponseJson"];
  const out = {};
  for (const k of allowed) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  if (input.summarizer && typeof input.summarizer === "object" && !Array.isArray(input.summarizer)) {
    const s = {};
    if (input.summarizer.mode !== undefined) s.mode = input.summarizer.mode;
    if (input.summarizer.connectionId !== undefined) s.connectionId = input.summarizer.connectionId;
    if (input.summarizer.model !== undefined) s.model = input.summarizer.model;
    if (Object.keys(s).length > 0) out.summarizer = s;
  }
  return out;
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
