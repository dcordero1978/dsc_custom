// DSC Custom — Retenciones Nicaragua en Payment Entry
// Agrega checkboxes para retención IR 2% y ALMA 1%
// Al marcarlos calcula automáticamente las deducciones

frappe.ui.form.on("Payment Entry", {

    // ── Cuando carga el formulario ──────────────────────────────────────────
    refresh(frm) {
        // Solo aplica a pagos de cobro (recepción de dinero de clientes)
        if (frm.doc.payment_type !== "Receive") return;
        if (frm.doc.docstatus !== 0) return; // Solo en modo edición

        dsc_setup_retencion_buttons(frm);
    },

    payment_type(frm) {
        if (frm.doc.payment_type !== "Receive") return;
        dsc_setup_retencion_buttons(frm);
    },

    // ── Checkbox IR 2% ─────────────────────────────────────────────────────
    dsc_retencion_ir(frm) {
        dsc_calcular_retenciones(frm);
    },

    // ── Checkbox ALMA 1% ───────────────────────────────────────────────────
    dsc_retencion_alma(frm) {
        dsc_calcular_retenciones(frm);
    },

    // ── Recalcular si cambia el monto pagado ────────────────────────────────
    paid_amount(frm) {
        if (frm.doc.dsc_retencion_ir || frm.doc.dsc_retencion_alma) {
            dsc_calcular_retenciones(frm);
        }
    },
});


function dsc_setup_retencion_buttons(frm) {
    // Asegura que los campos custom existen antes de usarlos
    if (!frm.fields_dict["dsc_retencion_ir"]) return;

    // Muestra la sección de retenciones
    frm.set_df_property("dsc_retencion_section", "hidden", 0);
}


function dsc_calcular_retenciones(frm) {
    if (frm.doc.payment_type !== "Receive") return;

    // Obtener el total de la factura referenciada
    let total_factura = 0;
    if (frm.doc.references && frm.doc.references.length > 0) {
        frm.doc.references.forEach(row => {
            total_factura += flt(row.allocated_amount);
        });
    }

    // Si no hay referencia, usar el monto pagado actual + deducciones previas
    if (total_factura === 0) {
        total_factura = flt(frm.doc.paid_amount);
        // Sumar deducciones DSC anteriores
        if (frm.doc.deductions) {
            frm.doc.deductions.forEach(row => {
                if (row.account && (
                    row.account.includes("1104-1") ||
                    row.account.includes("1104-3")
                )) {
                    total_factura += flt(row.amount);
                }
            });
        }
    }

    if (total_factura === 0) return;

    // Calcular montos de retención
    const monto_ir   = frm.doc.dsc_retencion_ir   ? flt(total_factura * 0.02, 2) : 0;
    const monto_alma = frm.doc.dsc_retencion_alma  ? flt(total_factura * 0.01, 2) : 0;

    // Limpiar deducciones DSC anteriores (no tocar otras deducciones)
    let otras_deducciones = [];
    if (frm.doc.deductions) {
        otras_deducciones = frm.doc.deductions.filter(row =>
            !row.account.includes("1104-1") && !row.account.includes("1104-3")
        );
    }

    // Reconstruir tabla de deducciones
    frm.clear_table("deductions");

    // Restaurar otras deducciones
    otras_deducciones.forEach(row => {
        frm.add_child("deductions", row);
    });

    // Agregar IR 2% si aplica
    if (monto_ir > 0) {
        frm.add_child("deductions", {
            account: dsc_get_account("1104-1", frm),
            amount: monto_ir,
            description: "Retención IR 2% (DGI)",
        });
    }

    // Agregar ALMA 1% si aplica
    if (monto_alma > 0) {
        frm.add_child("deductions", {
            account: dsc_get_account("1104-3", frm),
            amount: monto_alma,
            description: "Retención ALMA 1%",
        });
    }

    // Ajustar monto recibido en caja
    const total_retenciones = monto_ir + monto_alma;
    const nuevo_monto = flt(total_factura - total_retenciones, 2);

    frm.set_value("paid_amount", nuevo_monto);
    frm.refresh_field("deductions");
    frm.refresh_field("paid_amount");

    // Mostrar resumen al usuario
    if (total_retenciones > 0) {
        frappe.show_alert({
            message: `
                Retenciones aplicadas:<br>
                ${monto_ir > 0 ? `IR 2%: <b>C$ ${format_number(monto_ir)}</b><br>` : ""}
                ${monto_alma > 0 ? `ALMA 1%: <b>C$ ${format_number(monto_alma)}</b><br>` : ""}
                <hr>
                Neto a recibir: <b>C$ ${format_number(nuevo_monto)}</b>
            `,
            indicator: "blue"
        }, 5);
    }
}


function dsc_get_account(account_number, frm) {
    // Busca la cuenta por número en la compañía actual
    // Retorna el nombre completo de la cuenta (ej: "1104-1 - 2% IR (ANTICIPOS) - DSC")
    // Como fallback usamos el formato conocido
    const abbr = frm.doc.company ? frappe.get_doc("Company", frm.doc.company)?.abbr || "DSC" : "DSC";

    const known_accounts = {
        "1104-1": `1104-1 - 2% IR (ANTICIPOS) - ${abbr}`,
        "1104-3": `1104-3 - RETENCION  ALMA 1% - ${abbr}`,
    };

    return known_accounts[account_number] || account_number;
}


function format_number(n) {
    return n.toLocaleString("es-NI", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
