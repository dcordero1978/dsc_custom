// Las cuentas se filtran según la operación: Cobro -> activo, Pago -> pasivo.
frappe.ui.form.on("DSC Retencion Config", {
	setup(frm) {
		frm.set_query("cuenta", "reglas", (doc, cdt, cdn) => {
			const fila = locals[cdt][cdn];
			const filters = { company: doc.company, is_group: 0, disabled: 0 };
			if (fila.operacion === "Cobro") filters.root_type = "Asset";
			if (fila.operacion === "Pago") filters.root_type = "Liability";
			return { filters };
		});
	},
});
