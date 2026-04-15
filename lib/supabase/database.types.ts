export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      inventory_items: {
        Row: {
          id: string
          product_id: string
          serial_number: string
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
          reserved_for_request_line_id: string | null
          cloud_key: string | null
          deleted_at: string | null
        }
        Insert: {
          id: string
          product_id: string
          serial_number: string
          status: string
          date_added: string
          location: string
          client?: string | null
          notes?: string | null
          cloud_key?: string | null
          assigned_to?: string | null
          purchase_date?: string | null
          warranty_end_date?: string | null
          poc_out_date?: string | null
          return_date?: string | null
          assignment_history?: Json | null
          reserved_for_request_line_id?: string | null
          deleted_at?: string | null
        }
        Update: {
          id?: string
          product_id?: string
          serial_number?: string
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
          reserved_for_request_line_id?: string | null
          cloud_key?: string | null
          deleted_at?: string | null
        }
      }
      product_lines: {
        Row: {
          id: string
          product_name: string
          vendor: string
          created_at: string
        }
        Insert: {
          id: string
          product_name: string
          vendor?: string
          created_at?: string
        }
        Update: {
          id?: string
          product_name?: string
          vendor?: string
          created_at?: string
        }
      }
      stock_requests: {
        Row: {
          id: string
          client_id: string
          created_by: string
          status: string
          quotation_url: string | null
          notes: string | null
          serviced_at: string | null
          invoice_number: string | null
          invoice_document_url: string | null
          invoiced_at: string | null
          invoiced_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          created_by: string
          status?: string
          quotation_url?: string | null
          notes?: string | null
          serviced_at?: string | null
          invoice_number?: string | null
          invoice_document_url?: string | null
          invoiced_at?: string | null
          invoiced_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          created_by?: string
          status?: string
          quotation_url?: string | null
          notes?: string | null
          serviced_at?: string | null
          invoice_number?: string | null
          invoice_document_url?: string | null
          invoiced_at?: string | null
          invoiced_by?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      stock_request_lines: {
        Row: {
          id: string
          request_id: string
          product_name: string
          quantity_requested: number
          sort_order: number
        }
        Insert: {
          id?: string
          request_id: string
          product_name: string
          quantity_requested: number
          sort_order?: number
        }
        Update: {
          id?: string
          request_id?: string
          product_name?: string
          quantity_requested?: number
          sort_order?: number
        }
      }
      notifications: {
        Row: {
          id: string
          user_id: string
          type: string
          title: string
          body: string | null
          read_at: string | null
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: string
          title: string
          body?: string | null
          read_at?: string | null
          metadata?: Json
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: string
          title?: string
          body?: string | null
          read_at?: string | null
          metadata?: Json
          created_at?: string
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
          metadata: Json | null
          created_by: string | null
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
          metadata?: Json | null
          created_by?: string | null
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
          metadata?: Json | null
          created_by?: string | null
        }
      }
      kit_inspections: {
        Row: {
          id: string
          inventory_item_id: string
          serial_number: string
          inspector_name: string | null
          inspected_at: string
          outcome: string
          condition_notes: string | null
          attachment_urls: string[]
          transaction_id: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          inventory_item_id: string
          serial_number: string
          inspector_name?: string | null
          inspected_at?: string
          outcome: string
          condition_notes?: string | null
          attachment_urls?: string[]
          transaction_id?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          inventory_item_id?: string
          serial_number?: string
          inspector_name?: string | null
          inspected_at?: string
          outcome?: string
          condition_notes?: string | null
          attachment_urls?: string[]
          transaction_id?: string | null
          created_by?: string | null
          created_at?: string
        }
      }
      remediation_providers: {
        Row: {
          id: string
          slug: string
          display_name: string
          created_at: string
        }
        Insert: {
          id?: string
          slug: string
          display_name: string
          created_at?: string
        }
        Update: {
          id?: string
          slug?: string
          display_name?: string
          created_at?: string
        }
      }
      remediation_cases: {
        Row: {
          id: string
          provider_id: string
          faulty_inventory_item_id: string
          faulty_serial: string
          loaner_inventory_item_id: string | null
          loaner_serial: string | null
          provider_replacement_inventory_item_id: string | null
          provider_replacement_serial: string | null
          status: string
          date_sent_to_provider: string | null
          date_replacement_received: string | null
          tracking_reference: string | null
          notes: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          provider_id: string
          faulty_inventory_item_id: string
          faulty_serial: string
          loaner_inventory_item_id?: string | null
          loaner_serial?: string | null
          provider_replacement_inventory_item_id?: string | null
          provider_replacement_serial?: string | null
          status?: string
          date_sent_to_provider?: string | null
          date_replacement_received?: string | null
          tracking_reference?: string | null
          notes?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          provider_id?: string
          faulty_inventory_item_id?: string
          faulty_serial?: string
          loaner_inventory_item_id?: string | null
          loaner_serial?: string | null
          provider_replacement_inventory_item_id?: string | null
          provider_replacement_serial?: string | null
          status?: string
          date_sent_to_provider?: string | null
          date_replacement_received?: string | null
          tracking_reference?: string | null
          notes?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
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
          sites: { name?: string; address: string }[] | null
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
          sites?: { name?: string; address: string }[] | null
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
          sites?: { name?: string; address: string }[] | null
          total_orders?: number
          total_spent?: number
          last_order?: string | null
        }
      }
      batch_reversals: {
        Row: {
          batch_id: string
          reversed_at: string
          reversal_reason: string | null
          reversed_by: string | null
        }
        Insert: {
          batch_id: string
          reversed_at: string
          reversal_reason?: string | null
          reversed_by?: string | null
        }
        Update: {
          batch_id?: string
          reversed_at?: string
          reversal_reason?: string | null
          reversed_by?: string | null
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
    Functions: {
      ensure_product_line: {
        Args: { p_product_name: string; p_vendor: string }
        Returns: string
      }
      assign_serial_to_request_line: {
        Args: { p_line_id: string; p_inventory_item_id: string }
        Returns: undefined
      }
      release_serial_from_request_line: {
        Args: { p_inventory_item_id: string }
        Returns: undefined
      }
      create_request_serviced_notification: {
        Args: { p_request_id: string }
        Returns: undefined
      }
    }
  }
}
