import { NextResponse } from "next/server"

/**
 * Legacy endpoint: quick_scans table was removed (026). Movement history lives in
 * `transactions` + `inventory_items`; the app updates those via applyMovement.
 */
export async function GET() {
  return NextResponse.json([])
}

export async function POST() {
  return NextResponse.json({
    ok: true,
    recorded: 0,
    message: "Quick scan rows are no longer stored separately. Use Quick Scan / Stock Movement in the app (inventory + transactions update automatically).",
  })
}

export async function DELETE() {
  return NextResponse.json(
    { error: "Removing scan batches is not supported. Admins can reverse a batch from Transaction history." },
    { status: 405 }
  )
}
