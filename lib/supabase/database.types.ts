export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      inventory_items: {
        Row: {
          id: string
          serial_number: string
          item_type: string
          name: string
          category: string | null
          status: string
          date_added: string
          location: string
          client: string | null
          notes: string | null
          assigned_to: string | null
          purchase_date: string | null
          warranty_end_date: string | null
          poc_out_date: string | null
          return_date: string | null
          assignment_history: Json | null
        }
        Insert: {
          id: string
          serial_number: string
          item_type: string
          name: string
          category?: string | null
          status: string
          date_added: string
          location: string
          client?: string | null
          notes?: string | null
          assigned_to?: string | null
          purchase_date?: string | null
          warranty_end_date?: string | null
          poc_out_date?: string | null
          return_date?: string | null
          assignment_history?: Json | null
        }
        Update: {
          id?: string
          serial_number?: string
          item_type?: string
          name?: string
          category?: string | null
          status?: string
          date_added?: string
          location?: string
          client?: string | null
          notes?: string | null
          assigned_to?: string | null
          purchase_date?: string | null
          warranty_end_date?: string | null
          poc_out_date?: string | null
          return_date?: string | null
          assignment_history?: Json | null
        }
      }
      transactions: {
        Row: {
          id: string
          type: string
          serial_number: string
          item_name: string
          client: string
          date: string
          client_id: string | null
          invoice_number: string | null
          notes: string | null
          from_location: string | null
          to_location: string | null
          assigned_to: string | null
          disposal_reason: string | null
          authorised_by: string | null
          batch_id: string | null
          delivery_note_url: string | null
        }
        Insert: {
          id: string
          type: string
          serial_number: string
          item_name: string
          client: string
          date: string
          client_id?: string | null
          disposal_reason?: string | null
          authorised_by?: string | null
          batch_id?: string | null
          delivery_note_url?: string | null
          invoice_number?: string | null
          notes?: string | null
          from_location?: string | null
          to_location?: string | null
          assigned_to?: string | null
        }
        Update: {
          id?: string
          type?: string
          serial_number?: string
          item_name?: string
          client?: string
          date?: string
          client_id?: string | null
          disposal_reason?: string | null
          authorised_by?: string | null
          invoice_number?: string | null
          notes?: string | null
          from_location?: string | null
          to_location?: string | null
          assigned_to?: string | null
          batch_id?: string | null
          delivery_note_url?: string | null
        }
      }
      outbound_batches: {
        Row: {
          id: string
          type: string
          client: string | null
          client_id: string | null
          start_date: string
          end_date: string | null
          status: string
          invoice_number: string | null
          created_at: string
        }
        Insert: {
          id: string
          type: string
          client?: string | null
          client_id?: string | null
          start_date: string
          end_date?: string | null
          status?: string
          invoice_number?: string | null
          created_at: string
        }
        Update: {
          id?: string
          type?: string
          client?: string | null
          client_id?: string | null
          start_date?: string
          end_date?: string | null
          status?: string
          invoice_number?: string | null
          created_at?: string
        }
      }
      clients: {
        Row: {
          id: string
          name: string
          company: string
          email: string
          phone: string | null
          address: string | null
          total_orders: number
          total_spent: number
          last_order: string | null
        }
        Insert: {
          id: string
          name: string
          company: string
          email: string
          phone?: string | null
          address?: string | null
          total_orders?: number
          total_spent?: number
          last_order?: string | null
        }
        Update: {
          id?: string
          name?: string
          company?: string
          email?: string
          phone?: string | null
          address?: string | null
          total_orders?: number
          total_spent?: number
          last_order?: string | null
        }
      }
      quick_scans: {
        Row: {
          id: string
          serial_number: string
          scan_type: string
          scanned_at: string
          movement_type: string | null
          batch_id: string | null
          client_id: string | null
          client_name: string | null
          client_company: string | null
          client_email: string | null
          client_phone: string | null
          sites: { name?: string; address: string }[] | null
        }
        Insert: {
          id: string
          serial_number: string
          scan_type: string
          scanned_at: string
          movement_type?: string | null
          batch_id?: string | null
          client_id?: string | null
          client_name?: string | null
          client_company?: string | null
          client_email?: string | null
          client_phone?: string | null
          sites?: { name?: string; address: string }[] | null
        }
        Update: {
          id?: string
          serial_number?: string
          scan_type?: string
          scanned_at?: string
          movement_type?: string | null
          batch_id?: string | null
          client_id?: string | null
          client_name?: string | null
          client_company?: string | null
          client_email?: string | null
          client_phone?: string | null
          sites?: { name?: string; address: string }[] | null
        }
      }
      stock_takes: {
        Row: {
          id: string
          completed_at: string
          result_snapshot: Json
        }
        Insert: {
          id: string
          completed_at: string
          result_snapshot: Json
        }
        Update: {
          id?: string
          completed_at?: string
          result_snapshot?: Json
        }
      }
      profiles: {
        Row: {
          id: string
          email: string
          display_name: string | null
          role: string | null
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          display_name?: string | null
          role?: string | null
          active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          display_name?: string | null
          role?: string | null
          active?: boolean
          created_at?: string
          updated_at?: string
        }
      }
    }
  }
}
