// DSC Custom — Pricing Rule: tipo de margen "Margen sobre Venta"
//
// El servidor guarda la regla convertida (Porcentaje + markup equivalente, ver dsc_custom/pricing.py).
// Aqui solo se muestra la regla como la escribio el usuario: Margen sobre Venta + margen original.

const DSC_MARGEN_SOBRE_VENTA = "Margen sobre Venta";
const DSC_TOLERANCIA = 0.0001;

frappe.ui.form.on("Pricing Rule", {
	refresh(frm) {
		dsc_mostrar_margen_sobre_venta(frm);
		dsc_describir_margen(frm);
	},
	margin_type(frm) {
		dsc_describir_margen(frm);
	},
	margin_rate_or_amount(frm) {
		dsc_describir_margen(frm);
	},
});

function dsc_markup_equivalente(margen) {
	return (margen / (100 - margen)) * 100;
}

function dsc_mostrar_margen_sobre_venta(frm) {
	const margen = flt(frm.doc.dsc_margen_venta);
	if (frm.is_new() || !margen || margen >= 100 || frm.doc.margin_type !== "Percentage") return;
	if (Math.abs(flt(frm.doc.margin_rate_or_amount) - dsc_markup_equivalente(margen)) > DSC_TOLERANCIA) return;

	// Asignacion directa (no set_value) para que el formulario no quede marcado como modificado.
	frm.doc.margin_type = DSC_MARGEN_SOBRE_VENTA;
	frm.doc.margin_rate_or_amount = margen;
	frm.refresh_field("margin_type");
	frm.refresh_field("margin_rate_or_amount");
}

function dsc_describir_margen(frm) {
	if (frm.doc.margin_type !== DSC_MARGEN_SOBRE_VENTA) return;

	const margen = flt(frm.doc.margin_rate_or_amount);
	let texto = __("Margen sobre venta %. Precio = precio de lista ÷ (1 − margen/100).");
	if (margen > 0 && margen < 100) {
		texto +=
			" " +
			__("Equivale a un markup de {0}% sobre el precio de lista.", [
				flt(dsc_markup_equivalente(margen), 4),
			]);
	}
	frm.set_df_property("margin_rate_or_amount", "description", texto);
}
