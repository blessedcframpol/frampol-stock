import { describe, expect, it } from "vitest"
import { canEditClients } from "@/lib/permissions"
import {
  clientChipCounts,
  clientHasNoContact,
  clientListIdentity,
  compareClientsByName,
  displayLabel,
  holdingsForClient,
  realSites,
  splitEmails,
  type DirectoryClient,
  type HeldUnit,
} from "@/lib/clients-directory"

const joseph: DirectoryClient = {
  id: "j1",
  name: "Joseph Shenjere",
  company: "Delta Truck",
  email: "jo@example.com",
  phone: "0772000000",
}
const otherJoseph: DirectoryClient = {
  id: "j2",
  name: "Joseph Shenjere",
  company: "Delta Beverages",
  email: "N/A",
  phone: "",
}
const blank: DirectoryClient = {
  id: "b",
  name: "No Contact",
  company: "No Contact",
  email: "N/A",
  phone: "n/a",
}

const held: HeldUnit[] = [
  {
    id: "1",
    serialNumber: "H1",
    product: "Ruijie",
    kind: "POC",
    holder: "Joseph Shenjere",
    dateOut: "2026-06-01",
    returnDate: "2026-06-01",
  },
  {
    id: "2",
    serialNumber: "H2",
    product: "Ruijie",
    kind: "POC",
    holder: "Joseph Shenjere",
    dateOut: "2026-06-01",
    returnDate: "2026-06-01",
  },
  {
    id: "3",
    serialNumber: "H3",
    product: "Ruijie",
    kind: "POC",
    holder: "Joseph Shenjere",
    dateOut: "2026-06-01",
    returnDate: "2026-10-20",
  },
]

describe("client directory display", () => {
  it("hides placeholder contact values and splits emails", () => {
    expect(displayLabel({ name: "N/A", company: "N/A" })).toBe("—")
    expect(displayLabel({ name: "ABC Auctions", company: "ABC Auctions" })).toBe("ABC Auctions")
    expect(splitEmails("a@x.com; b@x.com; N/A")).toEqual(["a@x.com", "b@x.com"])
    expect(clientHasNoContact(blank)).toBe(true)
    expect(clientHasNoContact(joseph)).toBe(false)
    expect(realSites([{ address: "N/A" }, { name: "HQ", address: "1 Main" }])).toEqual([
      { name: "HQ", address: "1 Main" },
    ])
  })

  it("counts chips from the full directory and matches holdings to every same-name client", () => {
    const counts = clientChipCounts([joseph, otherJoseph, blank], held, "2026-10-01")
    expect(counts).toEqual({ all: 3, out: 2, overdue: 2, noContact: 2 })
    expect(holdingsForClient(held, joseph).map((unit) => unit.serialNumber)).toEqual(["H1", "H2", "H3"])
    expect(holdingsForClient(held, otherJoseph)).toHaveLength(3)
    expect(holdingsForClient(held, blank)).toHaveLength(0)
  })

})

describe("client list identity", () => {
  it("falls back from name to company to Unnamed client", () => {
    expect(clientListIdentity({ name: "ABC Auctions", company: "ABC Auctions" })).toEqual({
      title: "ABC Auctions",
      fallback: false,
    })
    expect(clientListIdentity({ name: "0", company: "Clinical Services Operations Company" })).toEqual({
      title: "Clinical Services Operations Company",
      fallback: true,
    })
    expect(clientListIdentity({ name: "000000000", company: "Prince Mubau" })).toEqual({
      title: "Prince Mubau",
      fallback: true,
    })
    expect(clientListIdentity({ name: "N/A", company: "N/A" })).toEqual({
      title: "Unnamed client",
      fallback: true,
    })
    expect(clientListIdentity({ name: "", company: "---" })).toEqual({
      title: "Unnamed client",
      fallback: true,
    })
  })

  it("sorts placeholder names after real names", () => {
    const rows = [
      { id: "z", name: "0", company: "Clinical Services Operations Company" },
      { id: "a", name: "Alice Stores", company: "Alice Stores" },
      { id: "n", name: "N/A", company: "N/A" },
      { id: "p", name: "000000000", company: "Prince Mubau" },
      { id: "b", name: "Baker Ltd", company: "Baker Ltd" },
      { id: "d", name: "---", company: "" },
      { id: "s", name: "176 Enterprise Rd", company: "Security Shop" },
    ]
    expect(rows.slice().sort(compareClientsByName).map((row) => row.id)).toEqual([
      "s",
      "a",
      "b",
      "z",
      "p",
      "d",
      "n",
    ])
  })
})

describe("client edit permission", () => {
  it("lets every role except viewer edit", () => {
    expect(canEditClients("viewer")).toBe(false)
    for (const role of ["admin", "sales", "accounts", "technicians"] as const) {
      expect(canEditClients(role)).toBe(true)
    }
  })
})
